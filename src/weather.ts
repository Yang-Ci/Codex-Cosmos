import type { WeatherLocation, WeatherState } from "./types";

interface OpenMeteoResponse {
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    weather_code: number;
    is_day: number;
  };
  hourly: {
    time: string[];
    precipitation_probability: number[];
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
    sunrise: string[];
    sunset: string[];
  };
}

export async function fetchWeather(location: WeatherLocation): Promise<WeatherState> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
  );
  url.searchParams.set("hourly", "precipitation_probability");
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
  );
  url.searchParams.set("timezone", location.timezone || "auto");
  url.searchParams.set("forecast_days", "7");

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`天气服务响应异常 (${response.status})`);
  const data = (await response.json()) as OpenMeteoResponse;
  const currentHour = data.current.time.slice(0, 13);
  const hourlyIndex = Math.max(0, data.hourly.time.findIndex((time) => time.startsWith(currentHour)));

  return {
    temperature: data.current.temperature_2m,
    apparentTemperature: data.current.apparent_temperature,
    humidity: data.current.relative_humidity_2m,
    windSpeed: data.current.wind_speed_10m,
    weatherCode: data.current.weather_code,
    isDay: data.current.is_day === 1,
    precipitationProbability: data.hourly.precipitation_probability[hourlyIndex] ?? 0,
    sunrise: data.daily.sunrise[0],
    sunset: data.daily.sunset[0],
    daily: data.daily.time.map((date, index) => ({
      date,
      code: data.daily.weather_code[index],
      max: data.daily.temperature_2m_max[index],
      min: data.daily.temperature_2m_min[index],
      rain: data.daily.precipitation_probability_max[index],
    })),
  };
}

export async function searchLocations(query: string): Promise<WeatherLocation[]> {
  if (query.trim().length < 2) return [];
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query.trim());
  url.searchParams.set("count", "6");
  url.searchParams.set("language", "zh");
  url.searchParams.set("format", "json");
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error("城市搜索失败");
  const data = (await response.json()) as {
    results?: Array<WeatherLocation>;
  };
  return data.results ?? [];
}

export function describeWeather(code: number): { label: string; glyph: string } {
  if (code === 0) return { label: "晴朗", glyph: "sun" };
  if (code <= 2) return { label: "少云", glyph: "cloud-sun" };
  if (code === 3) return { label: "阴天", glyph: "cloud" };
  if ([45, 48].includes(code)) return { label: "有雾", glyph: "fog" };
  if (code >= 51 && code <= 57) return { label: "细雨", glyph: "drizzle" };
  if (code >= 61 && code <= 67) return { label: "有雨", glyph: "rain" };
  if (code >= 71 && code <= 77) return { label: "有雪", glyph: "snow" };
  if (code >= 80 && code <= 82) return { label: "阵雨", glyph: "rain" };
  if (code >= 95) return { label: "雷雨", glyph: "storm" };
  return { label: "天气变化", glyph: "cloud" };
}
