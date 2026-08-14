// Black Hole Trash - a geodesic-traced Recycle Bin over the live desktop.
//
// Faithful WGSL port of s0xDk/ghostty-blackhole (MIT), itself after Eric
// Bruneton's "Real-time High-Quality Rendering of Non-Rotating Black Holes".
// Each pixel's null geodesic is integrated numerically in 3D - the Binet-form
// photon acceleration  a = -(3/2) h² x / r⁵  reproduces exact Schwarzschild
// bending. Everything falls out of that integration:
//
//   * shadow        - rays under b_crit = (3√3/2) r_s spiral into the horizon
//   * lensing       - escaped rays are projected back onto the desktop "sky"
//                     plane: your screen bends, magnifies, mirrors in the ring
//   * photon ring   - rays winding near the r = 1.5 r_s photon sphere
//   * accretion disk -  a thin tilted Keplerian disk the ray may cross several
//                     times (the far side arcs over and under the shadow);
//                     blackbody color from a Shakura-Sunyaev temperature
//                     profile, Doppler-shifted and beamed
//
// The terminal-specific modes (token/pomodoro/cursor decode) are replaced by
// a slow self-drift; the desktop capture plays the role of the lensed sky.
// A Kerr (spinning) mode integrates the exact rotating metric instead, see
// the Kerr section below.

// The disk "look" rides in the uniform buffer so the tray menu can switch
// presets live (values crossfaded on the CPU side).
struct Uniforms {
    resolution: vec2<f32>,
    time: f32,
    has_desktop: f32,
    temp: f32,          // hottest-annulus temperature, Kelvin
    incl: f32,          // disk inclination, rad (0 face-on, 1.57 edge-on)
    roll: f32,          // screen-plane rotation of the system
    inner: f32,         // disk inner edge, r_s
    outer: f32,         // disk outer edge, r_s
    opac: f32,          // near-disk opacity toward the background
    dopp: f32,          // Doppler mix (0 none, 1 full)
    beam: f32,          // beaming exponent
    gain: f32,          // disk emission brightness
    contr: f32,         // streak contrast
    wind: f32,          // spiral winding tightness
    speed: f32,         // streak speed; negative reverses orbit
    expo: f32,          // tonemap exposure
    star: f32,          // lensed starfield gain
    hole_radius: f32,   // shadow radius, fraction of screen height
    center_x: f32,      // hole centre in uv, computed on the CPU
    center_y: f32,      // (drift, pinned or follow-the-cursor placement)
    spin: f32,          // Kerr spin 0..0.99; 0 = Schwarzschild fast path
    spin_phase: f32,    // accumulated visible rotation, radians
    _pad: f32,
    cursor: vec4<f32>,
    cursor_motion: vec4<f32>,
    absorption_jet: vec4<f32>, // progress, batch energy, active, reserved
    cursor_trail: array<vec4<f32>, 16>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var desktop_tex: texture_2d<f32>;
@group(0) @binding(2) var desktop_samp: sampler;

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
    var verts = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    let xy = verts[vid];
    var out: VSOut;
    out.pos = vec4<f32>(xy, 0.0, 1.0);
    out.uv  = vec2<f32>(xy.x * 0.5 + 0.5, 1.0 - (xy.y * 0.5 + 0.5));
    return out;
}

// ---------------------------------------------------------------- tunables --
// Disk look, size and centre come from the uniforms (tray menu / config
// file / placement gesture); only the hole-independent knobs stay compile-time.
const LENS_DEPTH: f32    = 21.0;   // stronger small-widget lens: makes bent stars obvious at 124 px
const N_STEPS: i32       = 48;     // geodesic steps per pixel (perf dial)
const B_CRIT: f32        = 2.5980762; // critical impact parameter, r_s

// ------------------------------------------------------------------- helpers --
fn gmod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }

fn mirrorUV(uvin: vec2<f32>) -> vec2<f32> {
    let m = uvin - 2.0 * floor(uvin / 2.0);
    return 1.0 - abs(1.0 - m);
}

fn rot(v: vec2<f32>, a: f32) -> vec2<f32> {
    let c = cos(a);
    let s = sin(a);
    return vec2<f32>(c * v.x - s * v.y, s * v.x + c * v.y);
}

fn hash21(pin: vec2<f32>) -> f32 {
    var p = fract(pin * vec2<f32>(234.34, 435.345));
    p = p + dot(p, p + 34.23);
    return fract(p.x * p.y);
}

fn sd_segment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let ba = b - a;
    let h = clamp(dot(p - a, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    return length(p - (a + ba * h));
}

fn cross2(a: vec2<f32>, b: vec2<f32>) -> f32 {
    return a.x * b.y - a.y * b.x;
}

fn sd_triangle(
    p: vec2<f32>,
    a: vec2<f32>,
    b: vec2<f32>,
    c: vec2<f32>,
) -> f32 {
    let d = min(sd_segment(p, a, b), min(sd_segment(p, b, c), sd_segment(p, c, a)));
    let s0 = cross2(b - a, p - a);
    let s1 = cross2(c - b, p - b);
    let s2 = cross2(a - c, p - c);
    let inside = (s0 >= 0.0 && s1 >= 0.0 && s2 >= 0.0)
        || (s0 <= 0.0 && s1 <= 0.0 && s2 <= 0.0);
    return select(d, -d, inside);
}

fn sd_box(p: vec2<f32>, half_size: vec2<f32>) -> f32 {
    let q = abs(p) - half_size;
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0);
}

fn cursor_arrow_sdf(
    fragment_px: vec2<f32>,
    origin_px: vec2<f32>,
    direction_px: vec2<f32>,
    stretch: f32,
    scale: f32,
) -> f32 {
    let fallback = vec2<f32>(1.0, 0.0);
    let tangent = select(fallback, normalize(direction_px), length(direction_px) > 0.05);
    let normal = vec2<f32>(-tangent.y, tangent.x);
    let rel = fragment_px - origin_px;
    var local = vec2<f32>(dot(rel, tangent), dot(rel, normal));
    local.x = local.x / max(stretch, 0.1);
    local = local / max(scale, 0.05);

    let head = sd_triangle(
        local,
        vec2<f32>(10.5, 0.0),
        vec2<f32>(-3.5, -6.2),
        vec2<f32>(-3.5, 6.2),
    );
    let stem = sd_box(local - vec2<f32>(-5.0, 0.0), vec2<f32>(4.2, 1.75));
    return min(head, stem) * scale;
}

fn absorption_jet_overlay(base: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
    if (u.absorption_jet.z < 0.5) {
        return base;
    }

    let progress = clamp(u.absorption_jet.x, 0.0, 1.0);
    let energy = clamp(u.absorption_jet.y, 1.0, 1.5);
    let energy01 = (energy - 1.0) / 0.5;
    let aspect = u.resolution.x / max(u.resolution.y, 1.0);
    let center = vec2<f32>(u.center_x, u.center_y);
    let rel = (uv - center) * vec2<f32>(aspect, 1.0);
    let radius = max(u.hole_radius, 1e-4);

    var axis = normalize(rot(vec2<f32>(0.0, -1.0), -u.roll));
    if (axis.y > 0.0) {
        axis = -axis;
    }
    let tangent = vec2<f32>(-axis.y, axis.x);
    let axial = dot(rel, axis);
    let transverse = dot(rel, tangent);

    let attack = smoothstep(0.0, 0.13, progress);
    let decay = 1.0 - smoothstep(0.45, 1.0, progress);
    let envelope = attack * decay;
    let extension = smoothstep(0.0, 0.24, progress);
    let main_length = min(radius * mix(11.0, 14.0, energy01), 0.52) * extension;
    let base_width = radius * mix(0.38, 0.50, energy01);

    let main_distance = max(axial, 0.0);
    let main_fraction = clamp(main_distance / max(main_length, radius), 0.0, 1.0);
    let main_cap = step(0.0, axial)
        * (1.0 - smoothstep(main_length * 0.82, max(main_length, radius), main_distance));
    let main_width = base_width * mix(1.55, 0.42, main_fraction);
    let filament = 0.84 + 0.16 * sin(
        main_distance / radius * 10.0 - u.time * 34.0 + transverse / radius * 2.4,
    );
    let main_core = exp2(-pow(transverse / max(main_width * 0.20, 1e-5), 2.0) * 2.2)
        * main_cap
        * filament;
    let main_halo = exp2(-pow(transverse / max(main_width, 1e-5), 2.0) * 1.5)
        * main_cap;

    let counter_distance = max(-axial, 0.0);
    let counter_length = main_length * 0.64;
    let counter_fraction = clamp(
        counter_distance / max(counter_length, radius),
        0.0,
        1.0,
    );
    let counter_cap = step(0.0, -axial)
        * (1.0 - smoothstep(
            counter_length * 0.78,
            max(counter_length, radius),
            counter_distance,
        ));
    let counter_width = base_width * mix(1.35, 0.50, counter_fraction);
    let counter = exp2(-pow(transverse / max(counter_width, 1e-5), 2.0) * 1.7)
        * counter_cap
        * 0.18;

    let radial = length(rel);
    let shock_progress = smoothstep(0.02, 0.72, progress);
    let shock_radius = radius * mix(1.15, mix(4.8, 5.7, energy01), shock_progress);
    let shock_width = radius * mix(0.30, 0.09, shock_progress);
    let shock = exp2(-pow((radial - shock_radius) / max(shock_width, 1e-5), 2.0) * 2.8)
        * (1.0 - smoothstep(0.18, 0.78, progress));
    let flash = exp2(-pow(radial / max(radius * 0.95, 1e-5), 2.0) * 2.4)
        * (1.0 - smoothstep(0.0, 0.28, progress));

    var light = vec3<f32>(0.0);
    light = light
        + vec3<f32>(0.48, 0.60, 1.0) * main_halo * envelope * energy
        + vec3<f32>(0.96, 0.98, 1.0) * main_core * envelope * energy;
    light = light
        + vec3<f32>(0.58, 0.48, 1.0) * counter * envelope * energy
        + vec3<f32>(0.68, 0.80, 1.0) * shock * energy
        + vec3<f32>(0.92, 0.95, 1.0) * flash * energy;
    let contribution = vec3<f32>(1.0) - exp(-min(light, vec3<f32>(4.0)));
    return min(base + contribution, vec3<f32>(1.25));
}

fn cursor_overlay(base: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
    if (u.cursor_motion.z < 0.5) {
        return base;
    }

    let resolution = max(u.resolution, vec2<f32>(1.0));
    let fragment_px = uv * resolution;
    let center_px = vec2<f32>(u.center_x, u.center_y) * resolution;
    let hole_px = max(u.hole_radius * resolution.y, 1.0);
    if (length(fragment_px - center_px) > hole_px * 6.0 + 48.0) {
        return base;
    }
    let strength = clamp(u.cursor.z, 0.0, 1.0);
    let approach = smoothstep(0.06, 0.82, strength);
    let collapse = 0.0;

    var trail_glow = 0.0;
    var trail_ink = 0.0;
    for (var i: i32 = 0; i < 15; i = i + 1) {
        let ia = u32(i);
        let ib = u32(i + 1);
        let sa = u.cursor_trail[ia];
        let sb = u.cursor_trail[ib];
        var a = sa.xy * resolution;
        var b = sb.xy * resolution;
        let history = f32(i) / 14.0;
        let spiral_a = approach * history * 0.95
            + collapse * (3.8 + history * 1.1);
        let spiral_b = approach * (history + 1.0 / 14.0) * 0.95
            + collapse * (3.8 + (history + 1.0 / 14.0) * 1.1);
        a = center_px + rot(a - center_px, spiral_a);
        b = center_px + rot(b - center_px, spiral_b);
        let radial_collapse = collapse * collapse;
        let approach_a = approach * history * 0.18;
        let approach_b = approach * (history + 1.0 / 14.0) * 0.18;
        a = mix(
            a,
            center_px,
            clamp(approach_a + radial_collapse * mix(0.92, 0.56, history), 0.0, 1.0),
        );
        b = mix(
            b,
            center_px,
            clamp(approach_b + radial_collapse * mix(0.90, 0.52, history), 0.0, 1.0),
        );
        let distance = sd_segment(fragment_px, a, b);
        let width = mix(1.2, 7.5, history) * mix(0.75, 1.35, strength);
        let age = 0.5 * (sa.z + sb.z);
        let age_fade = 1.0 - smoothstep(0.10, 0.38, age);
        let history_fade = 1.0 - smoothstep(0.25, 1.0, history);
        let valid = min(sa.w, sb.w);
        let weight = age_fade * history_fade * valid;
        trail_glow = trail_glow
            + exp2(-distance * distance / max(width * width, 0.5)) * weight;
        trail_ink = trail_ink
            + (1.0 - smoothstep(0.4, width * 0.48 + 0.7, distance)) * weight;
    }

    var color = base * (1.0 - clamp(trail_ink * 0.018, 0.0, 0.055));
    color = color + vec3<f32>(0.32, 0.92, 0.78) * min(trail_glow * 0.025, 0.085);

    let horizon_mask = smoothstep(hole_px * 0.58, hole_px * 0.94, length(fragment_px - center_px));
    return mix(base, color, horizon_mask);
}

// value noise whose y lattice wraps every perY cells - the disk's angular
// dimension, so streaks tile seamlessly across the atan branch cut
fn vnoiseWrapY(p: vec2<f32>, perY: f32) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    let y0 = gmod(i.y, perY);
    let y1 = gmod(i.y + 1.0, perY);
    return mix(mix(hash21(vec2<f32>(i.x, y0)),       hash21(vec2<f32>(i.x + 1.0, y0)), f.x),
               mix(hash21(vec2<f32>(i.x, y1)),       hash21(vec2<f32>(i.x + 1.0, y1)), f.x),
               f.y);
}

// blackbody color from temperature in Kelvin (Tanner Helland fit, normalized)
fn blackbody(T: f32) -> vec3<f32> {
    let t = clamp(T, 1500.0, 40000.0) / 100.0;
    var r = 1.0;
    if (t > 66.0) { r = clamp(1.292936 * pow(t - 60.0, -0.1332047), 0.0, 1.0); }
    var g = 0.0;
    if (t <= 66.0) { g = clamp(0.3900816 * log(t) - 0.6318414, 0.0, 1.0); }
    else           { g = clamp(1.1298909 * pow(t - 60.0, -0.0755148), 0.0, 1.0); }
    var b = 1.0;
    if (t < 66.0) {
        if (t <= 19.0) { b = 0.0; }
        else { b = clamp(0.5432068 * log(t - 10.0) - 1.1962540, 0.0, 1.0); }
    }
    return vec3<f32>(r, g, b);
}

// sparse procedural starfield indexed by (bent) ray direction
fn stars(d: vec3<f32>) -> vec3<f32> {
    let sph = vec2<f32>(atan2(d.x, -d.z), asin(clamp(d.y, -1.0, 1.0)));
    let g   = sph * 40.0;
    let id  = floor(g);
    let h   = hash21(id);
    if (h < 0.92) { return vec3<f32>(0.0); }
    let f   = fract(g) - 0.5;
    let off = (vec2<f32>(hash21(id + 17.3), hash21(id + 31.7)) - 0.5) * 0.7;
    let spark = smoothstep(0.10, 0.0, length(f - off));
    let tw    = 0.7 + 0.3 * sin(u.time * (0.5 + 2.0 * hash21(id + 5.1)) + 40.0 * h);
    let tint  = mix(vec3<f32>(1.0, 0.82, 0.60), vec3<f32>(0.75, 0.85, 1.0), hash21(id + 2.9));
    return tint * spark * tw * ((h - 0.92) / 0.08);
}

fn terrain_warp(uvin: vec2<f32>) -> vec2<f32> {
    let mode = u.absorption_jet.w;
    let intensity = clamp(u.cursor_motion.w, 0.0, 1.0);
    if (mode < 0.5 || intensity < 0.001) {
        return uvin;
    }
    let aspect = u.resolution.x / max(u.resolution.y, 1.0);
    let anchor = mix(vec2<f32>(u.center_x, u.center_y), u.cursor.xy, u.cursor.z);
    let p = (uvin - anchor) * vec2<f32>(aspect, 1.0);
    let r = length(p);
    let direction = p / max(r, 1e-4);
    var offset = vec2<f32>(0.0);

    if (mode < 1.5) {
        // Gravity dent: a soft depression with a raised rim.
        let bowl = exp(-r * r * 18.0);
        let rim = exp(-pow((r - 0.19) / 0.055, 2.0));
        offset = direction * (bowl * -0.078 + rim * 0.022) * intensity;
    } else if (mode < 2.5) {
        // Lunar crater: compact bowl plus a broken circular shock rim.
        let bowl = exp(-r * r * 42.0);
        let rim = sin(r * 88.0 - u.time * 2.2) * exp(-r * 9.5);
        offset = direction * (-bowl * 0.06 + rim * 0.012) * intensity;
    } else if (mode < 3.5) {
        // Liquid desktop: two travelling wave fields react to pointer motion.
        let wave = sin((uvin.x * 13.0 + u.time * 0.72) * 6.283)
            + cos((uvin.y * 11.0 - u.time * 0.58) * 6.283);
        let pointer_wave = sin(r * 72.0 - u.time * 5.2) * exp(-r * 5.5);
        offset = vec2<f32>(wave, -wave) * 0.0035 * intensity
            + direction * pointer_wave * 0.012 * intensity;
    } else if (mode < 4.5) {
        // Snow presses down gently under the pointer.
        offset = direction * -exp(-r * r * 28.0) * 0.025 * intensity;
    } else if (mode < 5.5) {
        // Dunes bend the sampled desktop into wind-carved ridges.
        let ridge = sin((uvin.x * 1.35 + uvin.y) * 82.0 + u.time * 0.28);
        offset = vec2<f32>(0.006, 0.002) * ridge * intensity;
    } else {
        // Space dust swirls out of the pointer path and slowly gathers again.
        let swirl = exp(-r * 4.2) * (0.028 + 0.02 * u.cursor.z) * intensity;
        offset = vec2<f32>(-direction.y, direction.x) * swirl;
    }
    return uvin + offset / vec2<f32>(aspect, 1.0);
}

fn terrain_surface(base: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
    let mode = u.absorption_jet.w;
    let intensity = clamp(u.cursor_motion.w, 0.0, 1.0);
    if (mode < 0.5 || intensity < 0.001) {
        return base;
    }
    let aspect = u.resolution.x / max(u.resolution.y, 1.0);
    let anchor = mix(vec2<f32>(u.center_x, u.center_y), u.cursor.xy, u.cursor.z);
    let p = (uv - anchor) * vec2<f32>(aspect, 1.0);
    let r = length(p);
    var color = base;
    if (mode < 1.5) {
        let shade = exp(-r * r * 25.0) - exp(-pow((r - 0.2) / 0.045, 2.0)) * 0.55;
        color *= 1.0 - shade * 0.22 * intensity;
    } else if (mode < 2.5) {
        let ring = exp(-pow((r - 0.16) / 0.027, 2.0));
        let inner = exp(-r * r * 55.0);
        color = color * (1.0 - inner * 0.32 * intensity)
            + vec3<f32>(0.42, 0.56, 0.62) * ring * 0.18 * intensity;
    } else if (mode < 3.5) {
        let caustic = pow(max(0.0, sin((uv.x + uv.y) * 94.0 + u.time * 2.1)), 14.0);
        color += vec3<f32>(0.32, 0.78, 0.88) * caustic * 0.16 * intensity;
    } else if (mode < 4.5) {
        let grain = hash21(floor(uv * u.resolution / 5.0));
        let settle = smoothstep(0.48, 0.02, uv.y) * (0.72 + grain * 0.28);
        let brushed = 1.0 - exp(-r * r * 35.0) * u.cursor.z;
        color = mix(color, vec3<f32>(0.82, 0.92, 0.96), settle * brushed * 0.42 * intensity);
    } else if (mode < 5.5) {
        let ridges = 0.5 + 0.5 * sin((uv.x * 1.25 + uv.y) * 90.0 + u.time * 0.24);
        color = mix(color, color * vec3<f32>(1.17, 1.04, 0.76), ridges * 0.2 * intensity);
    } else {
        let cell = floor(uv * u.resolution / 7.0);
        let dust = step(0.87, hash21(cell + floor(u.time * 0.12)))
            * (1.0 - smoothstep(0.08, 0.42, r));
        color += vec3<f32>(0.50, 0.82, 1.0) * dust * 0.38 * intensity;
    }
    return color;
}

// live desktop when available; procedural test pattern otherwise
fn background(uvin: vec2<f32>) -> vec3<f32> {
    let uvm = mirrorUV(terrain_warp(uvin));
    if (u.has_desktop > 0.5) {
        return textureSampleLevel(desktop_tex, desktop_samp, uvm, 0.0).rgb;
    }
    let grad = vec3<f32>(uvm.x, uvm.y, 0.6);
    let cx = step(0.5, fract(uvm.x * 16.0));
    let cy = step(0.5, fract(uvm.y * 9.0));
    let c  = abs(cx - cy);
    let checker = mix(vec3<f32>(0.05, 0.06, 0.09), vec3<f32>(0.14, 0.16, 0.22), c);
    return mix(checker, grad, 0.35);
}

// Shade one thin-disk crossing. xc/vdir in world space; returns the
// transmittance-weighted emission in rgb and the local density in a.
fn shade_crossing(
    xc: vec3<f32>, vdir: vec3<f32>, n: vec3<f32>, e2: vec3<f32>,
    rin: f32, rout: f32, t: f32, sdir: f32, spd: f32, trans: f32,
) -> vec4<f32> {
    let rc = length(xc);
    if (rc <= rin || rc >= rout) {
        return vec4<f32>(0.0);
    }
    let band = smoothstep(rin, rin * 1.25, rc)
             * (1.0 - smoothstep(rout * 0.70, rout, rc));

    // disk-plane polar coords for the streak texture
    let phi   = atan2(dot(xc, e2), xc.x);
    let turns = phi / 6.2831853;
    let kep   = pow(rin / rc, 1.5);
    // sqrt(1 - 1.5/r): time runs slower for the inner orbits
    let gloc  = sqrt(max(1.0 - 1.5 / rc, 0.02));
    let swirl = rc * u.wind * 0.12 - t * kep * spd * gloc * sdir - u.spin_phase * kep;
    var streaks = vnoiseWrapY(vec2<f32>(rc * 2.8, turns * 19.0 + swirl * 3.0), 19.0) * 0.65
                + vnoiseWrapY(vec2<f32>(rc * 1.0, turns * 9.0  + swirl * 1.5 + 7.0), 9.0) * 0.35;
    streaks = 0.35 + u.contr * streaks * streaks;

    // relativistic Doppler + gravitational shift for circular-orbit gas
    let gasdir = normalize(cross(n, xc)) * sdir;
    let beta   = clamp(inverseSqrt(max(2.0 * (rc - 1.0), 0.2)), 0.0, 0.99);
    var g = gloc / max(1.0 + beta * dot(gasdir, vdir), 0.05);
    g = mix(1.0, g, u.dopp);

    // Shakura-Sunyaev temperature profile, peak normalized to 1
    let xpr   = max(1.0 - sqrt(rin / rc), 0.0);
    let tprof = pow(rin / rc, 0.75) * pow(xpr, 0.25) / 0.488;
    let cbb   = blackbody(u.temp * tprof * g);
    let boost = pow(g, u.beam);

    let density = band * streaks;
    return vec4<f32>(trans * cbb * (u.gain * 2.2 * density * tprof * tprof * boost), density);
}

// -------------------------- Kerr (spinning) mode ---------------------------
// Exact Kerr null geodesics via the Hamiltonian in Kerr-Schild coordinates:
// H = 1/2 (|p|^2 - E^2) - 1/2 f (l.p + E)^2, with f = 2 M r^3/(r^4 + a^2 z^2).
// M = 0.5 so r_s = 2M = 1 keeps every existing unit; the user-facing spin
// 0..1 maps to a = 0.5 spin (extremal at a = M). dx/dlambda is analytic and
// dp/dlambda comes from central differences of H, which avoids hand-deriving
// Christoffel symbols while integrating the exact metric.
const KERR_STEPS: i32 = 88;

// Prograde ISCO radius in r_s units (Bardeen 1972). spin = a/M in [0,1).
// At spin 0 this is 3 r_s (= 6M), shrinking toward ~0.6 r_s as spin -> 1:
// a fast-spinning hole lets the disk hug the shadow, which is the most
// visible consequence of spin.
// Dramatized frame-drag swirl. The exact azimuthal twist of Kerr lensing
// is physically real but imperceptible at desktop scale, so the VISIBLE
// layer exaggerates it: background samples rotate around the hole, strongest
// near the ring, prograde with the disk. Zero spin is an exact no-op.
fn drag_twist(b_rs: f32, spin_signed: f32, spin_phase: f32) -> f32 {
    let active_phase = select(0.0, spin_phase, abs(spin_signed) >= 0.005);
    return (1.3 * spin_signed + active_phase)
        / (1.0 + 0.8 * pow(b_rs / B_CRIT, 2.0));
}

fn kerr_isco_rs(spin: f32) -> f32 {
    let a = clamp(spin, 0.0, 0.999);
    let z1 = 1.0 + pow(1.0 - a * a, 1.0 / 3.0)
           * (pow(1.0 + a, 1.0 / 3.0) + pow(1.0 - a, 1.0 / 3.0));
    let z2 = sqrt(3.0 * a * a + z1 * z1);
    let r_m = 3.0 + z2 - sqrt((3.0 - z1) * (3.0 + z1 + 2.0 * z2));
    return r_m * 0.5; // M units -> r_s units (r_s = 2M)
}

fn ks_r(pos: vec3<f32>, a: f32) -> f32 {
    let rho2 = dot(pos, pos);
    let bq = rho2 - a * a;
    let r2 = 0.5 * (bq + sqrt(bq * bq + 4.0 * a * a * pos.z * pos.z));
    return sqrt(max(r2, 1e-8));
}

fn kerr_h(pos: vec3<f32>, pm: vec3<f32>, a: f32) -> f32 {
    let r = ks_r(pos, a);
    let r2 = r * r;
    let den = r2 + a * a;
    let l = vec3<f32>(
        (r * pos.x + a * pos.y) / den,
        (r * pos.y - a * pos.x) / den,
        pos.z / max(r, 1e-6),
    );
    let f = r2 * r / (r2 * r2 + a * a * pos.z * pos.z); // 2 M r^3 / (...), M = 0.5
    let lp = dot(l, pm) + 1.0; // l^mu p_mu with E = 1 (outgoing KS; exact Kerr outside the horizon)
    return 0.5 * (dot(pm, pm) - 1.0) - 0.5 * f * lp * lp;
}

fn kerr_dxdl(pos: vec3<f32>, pm: vec3<f32>, a: f32) -> vec3<f32> {
    let r = ks_r(pos, a);
    let r2 = r * r;
    let den = r2 + a * a;
    let l = vec3<f32>(
        (r * pos.x + a * pos.y) / den,
        (r * pos.y - a * pos.x) / den,
        pos.z / max(r, 1e-6),
    );
    let f = r2 * r / (r2 * r2 + a * a * pos.z * pos.z);
    let lp = dot(l, pm) + 1.0; // matches kerr_h
    return pm - f * lp * l;
}

fn kerr_dpdl(pos: vec3<f32>, pm: vec3<f32>, a: f32) -> vec3<f32> {
    let e = 2e-3;
    return vec3<f32>(
        kerr_h(pos - vec3<f32>(e, 0.0, 0.0), pm, a) - kerr_h(pos + vec3<f32>(e, 0.0, 0.0), pm, a),
        kerr_h(pos - vec3<f32>(0.0, e, 0.0), pm, a) - kerr_h(pos + vec3<f32>(0.0, e, 0.0), pm, a),
        kerr_h(pos - vec3<f32>(0.0, 0.0, e), pm, a) - kerr_h(pos + vec3<f32>(0.0, 0.0, e), pm, a),
    ) / (2.0 * e);
}

// ---------------------------------------------------------------------- main --
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let uv     = in.uv;
    let aspect = u.resolution.x / max(u.resolution.y, 1.0);
    let t      = u.time;

    let rin  = max(u.inner, 1.6);
    let rout = max(u.outer, rin + 0.5);
    let rh   = u.hole_radius;            // shadow radius in screen units

    // hole centre computed on the CPU (drift / pinned / follow-the-cursor)
    let center = vec2<f32>(u.center_x, u.center_y);

    // aspect-corrected frame centered on the hole (y in screen heights)
    let p    = (uv - center) * vec2<f32>(aspect, 1.0);
    let plen = length(p);

    // screen <-> world: shadow's angular size is B_CRIT r_s at rh screen units
    let W  = B_CRIT / max(rh, 1e-4);
    let pr = rot(vec2<f32>(p.x, -p.y), u.roll) * W;
    let b  = length(pr);                 // impact parameter, r_s units

    // fade real 1/b lensing a few disk diameters out so the whole screen
    // doesn't shimmer as the hole drifts (deliberately unphysical)
    let window = exp(-pow(plen / (7.0 * rh), 2.0));

    let bmax = rout + 3.0;               // rays beyond this can't touch the disk
    let Z0   = max(14.0, rout + 5.0);    // camera distance (shared with tracer)

    // ================= far field: analytic weak deflection ==================
    // finite-camera fitted mapping - sub-1% displacement match at the handoff
    // circle, so there is no visible seam against the integrated region
    if (b >= bmax) {
        let uu   = Z0 * inverseSqrt(Z0 * Z0 + b * b);
        let defl = (2.0 / (W * W)) / max(plen, 1e-4)
                 * (1.29 * uu + 0.07) * max(LENS_DEPTH - 2.14 * uu + 0.75, 0.0)
                 * window;
        let dir = p / max(plen, 1e-5);
        // mild chromatic aberration: blue bends a touch more than red
        let ab = 0.035 * smoothstep(1.0, 2.0, b / bmax);
        let sdir_far = select(1.0, -1.0, u.speed < 0.0);
        let tw = drag_twist(b, u.spin * sdir_far, u.spin_phase);
        let sp_r = rot(p - dir * defl * (1.0 - ab), tw);
        let sp_g = rot(p - dir * defl, tw);
        let sp_b = rot(p - dir * defl * (1.0 + ab), tw);
        let col = vec3<f32>(
            background(center + sp_r / vec2<f32>(aspect, 1.0)).r,
            background(center + sp_g / vec2<f32>(aspect, 1.0)).g,
            background(center + sp_b / vec2<f32>(aspect, 1.0)).b,
        );
        let d = normalize(vec3<f32>(-(pr / b) * (2.0 / b), -1.0));
        let scene = terrain_surface(col + stars(d) * u.star * window, uv);
        return vec4<f32>(
            cursor_overlay(absorption_jet_overlay(scene, uv), uv),
            1.0,
        );
    }

    // ====================== near field: trace the geodesic ==================
    // Parallel rays from a distant camera at +z; hole at origin, r_s = 1.
    var x = vec3<f32>(pr, Z0);
    var v = vec3<f32>(0.0, 0.0, -1.0);
    let h2 = dot(pr, pr);                // conserved angular momentum²

    // disk plane: normal tilted DISK_INCL about the screen x-axis
    let ci = cos(u.incl);
    let si = sin(u.incl);
    let n  = vec3<f32>(0.0, si, ci);
    let e2 = vec3<f32>(0.0, ci, -si);    // in-plane axis completing (x̂, e2, n)
    let sdir = select(1.0, -1.0, u.speed < 0.0);
    let spd  = abs(u.speed);

    var emitc = vec3<f32>(0.0);          // accumulated disk light (HDR)
    var trans = 1.0;                     // transmittance toward the background
    var captured = false;

    if (u.spin < 0.005) {
        // -------- Schwarzschild fast path (non-spinning) --------
        var sPrev = dot(x, n);
        var xPrev = x;
        for (var i: i32 = 0; i < N_STEPS; i = i + 1) {
            var r2 = dot(x, x);
            if (r2 < 1.0) { captured = true; break; }     // through the horizon
            if (x.z < -Z0 && v.z < 0.0) { break; }        // escaped out the back
            if (r2 > 4.0 * Z0 * Z0) { break; }            // flung far sideways
            var r = sqrt(r2);
            // step scales with radius: fine near the photon sphere
            let dt = clamp(0.16 * r, 0.03, 1.5);
            // leapfrog (kick-drift-kick) keeps near-critical orbits stable
            var acc = -1.5 * h2 * x / (r2 * r2 * r);
            v = v + acc * (0.5 * dt);
            x = x + v * dt;
            r2 = dot(x, x);
            r  = sqrt(r2);
            acc = -1.5 * h2 * x / (r2 * r2 * r);
            v = v + acc * (0.5 * dt);

            // thin-disk crossing
            let s = dot(x, n);
            if (s * sPrev < 0.0 && trans > 0.02) {
                let tc = sPrev / (sPrev - s);
                let xc = mix(xPrev, x, tc);
                let sh = shade_crossing(xc, normalize(v), n, e2, rin, rout, t, sdir, spd, trans);
                emitc = emitc + sh.rgb;
                trans = trans * (1.0 - clamp(u.opac * sh.a, 0.0, 1.0));
            }
            sPrev = s;
            xPrev = x;
        }
        // rays still winding when the budget ran out are as good as captured
        if (!captured && dot(x, x) < 4.0) { captured = true; }
    } else {
        // -------- Kerr path: exact spinning-hole geodesics --------
        // Integrate in the black hole frame where the spin axis is +z (the
        // disk normal): rows of the world->BH rotation are (x_hat, e2, n).
        let a = 0.5 * u.spin * sdir;     // a = M spin, prograde with the disk
        let rhor = 0.5 + sqrt(max(0.25 - a * a, 0.0)); // event horizon radius
        // spin shrinks the ISCO, so the disk reaches much closer to the
        // hole: scale the preset inner edge by the ISCO ratio (ISCO = 3 r_s
        // at zero spin) and keep it just outside the horizon
        let rin_k = max(rin * kerr_isco_rs(u.spin) / 3.0, kerr_isco_rs(u.spin));
        var xb = vec3<f32>(x.x, dot(x, e2), dot(x, n));
        var pb = vec3<f32>(v.x, dot(v, e2), dot(v, n));
        var sPrev = xb.z;
        var xPrev = xb;
        for (var i: i32 = 0; i < KERR_STEPS; i = i + 1) {
            let r = ks_r(xb, a);
            if (r < rhor + 0.02) { captured = true; break; }
            if (r > 1.4 * Z0 && dot(xb, kerr_dxdl(xb, pb, a)) > 0.0) { break; }
            // leapfrog in Hamiltonian form; dp from central differences of H
            let dl = clamp(0.16 * r, 0.02, 1.1);
            pb = pb + kerr_dpdl(xb, pb, a) * (0.5 * dl);
            xb = xb + kerr_dxdl(xb, pb, a) * dl;
            pb = pb + kerr_dpdl(xb, pb, a) * (0.5 * dl);

            // thin-disk crossing at the BH equator (z = 0 in this frame)
            if (xb.z * sPrev < 0.0 && trans > 0.02) {
                let tc = sPrev / (sPrev - xb.z);
                let xcb = mix(xPrev, xb, tc);
                // back to world space for the shared disk shading
                let xc = xcb.x * vec3<f32>(1.0, 0.0, 0.0) + xcb.y * e2 + xcb.z * n;
                let vb = kerr_dxdl(xb, pb, a);
                let vw = vb.x * vec3<f32>(1.0, 0.0, 0.0) + vb.y * e2 + vb.z * n;
                let sh = shade_crossing(xc, normalize(vw), n, e2, rin, rout, t, sdir, spd, trans);
                emitc = emitc + sh.rgb;
                trans = trans * (1.0 - clamp(u.opac * sh.a, 0.0, 1.0));
            }
            sPrev = xb.z;
            xPrev = xb;
        }
        // budget exhausted while still winding near the photon orbits
        // (Kerr retrograde photon orbit reaches r = 4M = 2.0; add margin)
        if (!captured && ks_r(xb, a) < 2.4) { captured = true; }
        // back to world space for the shared background projection
        let vb = kerr_dxdl(xb, pb, a);
        x = xb.x * vec3<f32>(1.0, 0.0, 0.0) + xb.y * e2 + xb.z * n;
        v = vb.x * vec3<f32>(1.0, 0.0, 0.0) + vb.y * e2 + vb.z * n;
    }

    // ---- background: where did the escaped ray come from? ----
    var bg = vec3<f32>(0.0);
    if (!captured) {
        let d = normalize(v);
        bg = bg + stars(d) * u.star * window;
        if (d.z < -0.05) {
            // project the exit ray onto the desktop sky plane at z = -LENS_DEPTH
            let tpl = (-LENS_DEPTH - x.z) / d.z;
            let hp  = x + d * tpl;
            let q   = rot(hp.xy, -u.roll) / W;
            var sp  = vec2<f32>(q.x, -q.y);
            sp = rot(sp, drag_twist(b, u.spin * sdir, u.spin_phase));
            // fade the *displacement*, never the color - no seam anywhere
            let suv = center + (p + (sp - p) * window) / vec2<f32>(aspect, 1.0);
            // rays bent past ~90° never reach the sky plane; fade them out
            let toward = smoothstep(0.05, 0.35, -d.z);
            bg = bg + background(suv) * toward;
        }
    }

    // disk light is HDR; tonemap it on top of the (untouched) desktop sample
    let col = terrain_surface(bg * trans + (vec3<f32>(1.0) - exp(-emitc * u.expo)), uv);
    return vec4<f32>(
        cursor_overlay(absorption_jet_overlay(col, uv), uv),
        1.0,
    );
}
