import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/runtimeManager";
import { getPrefixes } from "@utils/pluginManager";
import type { MessageContext } from "@mtcute/dispatcher";
import { thtml as html } from "@mtcute/html-parser";
import { htmlEscape } from "@utils/htmlEscape";
import { getErrorMessage } from "@utils/errorHelpers";
import { logger } from "@utils/logger";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  timezone_abbreviation: string;
  elevation: number;
  current?: {
    time: string;
    interval: number;
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    precipitation: number;
    rain: number;
    snowfall: number;
    weather_code: number;
    cloud_cover: number;
    pressure_msl: number;
    surface_pressure: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    wind_gusts_10m: number;
  };
  daily?: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    sunrise: string[];
    sunset: string[];
    precipitation_sum: number[];
    wind_speed_10m_max: number[];
  };
}

const weatherCodeMap: Record<number, { icon: string; description: string }> = {
  0: { icon: "☀️", description: "晴朗" },
  1: { icon: "🌤️", description: "大部晴朗" },
  2: { icon: "⛅", description: "部分多云" },
  3: { icon: "☁️", description: "阴天" },
  45: { icon: "🌫️", description: "有雾" },
  48: { icon: "🌫️", description: "沉积雾凇" },
  51: { icon: "🌦️", description: "轻度细雨" },
  53: { icon: "🌦️", description: "中度细雨" },
  55: { icon: "🌦️", description: "密集细雨" },
  56: { icon: "🌨️", description: "轻度冻雨" },
  57: { icon: "🌨️", description: "密集冻雨" },
  61: { icon: "🌧️", description: "轻度降雨" },
  63: { icon: "🌧️", description: "中度降雨" },
  65: { icon: "🌧️", description: "强降雨" },
  66: { icon: "🌨️", description: "轻度冻雨" },
  67: { icon: "🌨️", description: "强冻雨" },
  71: { icon: "❄️", description: "轻度降雪" },
  73: { icon: "❄️", description: "中度降雪" },
  75: { icon: "❄️", description: "强降雪" },
  77: { icon: "🌨️", description: "雪粒" },
  80: { icon: "🌦️", description: "轻度阵雨" },
  81: { icon: "🌧️", description: "中度阵雨" },
  82: { icon: "⛈️", description: "强阵雨" },
  85: { icon: "🌨️", description: "轻度阵雪" },
  86: { icon: "🌨️", description: "强阵雪" },
  95: { icon: "⛈️", description: "雷暴" },
  96: { icon: "⛈️", description: "轻度冰雹雷暴" },
  99: { icon: "⛈️", description: "强冰雹雷暴" },
};

function calcWindDirection(deg: number): string {
  const dirs = [
    "北", "北东北", "东北", "东东北", "东", "东东南", "东南", "南东南",
    "南", "南西南", "西南", "西西南", "西", "西西北", "西北", "北西北",
  ];
  const ix = Math.round(deg / 22.5);
  return dirs[ix % 16];
}

const help_text = `🌤️ <b>天气查询插件</b>

<b>📝 功能描述:</b>
• 🌡️ <b>实时天气</b>：查询全球城市实时天气信息
• 🌍 <b>自动识别</b>：自动识别中文城市名并转换
• 📊 <b>详细数据</b>：温度、湿度、风速、气压等
• 🌅 <b>日出日落</b>：显示当地日出日落时间
• 🆓 <b>完全免费</b>：使用 Open-Meteo 免费API

<b>🔧 使用方法:</b>
• <code>${mainPrefix}weather &lt;城市名&gt;</code> - 查询指定城市天气

<b>💡 使用示例:</b>
• <code>${mainPrefix}weather 北京</code> - 查询北京天气
• <code>${mainPrefix}weather beijing</code> - 使用英文查询
• <code>${mainPrefix}weather New York</code> - 查询纽约天气
• <code>${mainPrefix}weather 东京</code> - 查询东京天气

<b>🌐 支持格式:</b>
• 中文城市名：自动翻译为英文（使用Google翻译）
• 英文城市名：直接查询
• 支持全球所有城市

<b>📌 注意事项:</b>
• 城市名不区分大小写
• 中文自动识别并转换
• 数据来源：Open-Meteo (免费、无需API密钥)`;

class WeatherPlugin extends Plugin {
  name = "weather";
  description: string = help_text;
  private apiUrl = "https://api.open-meteo.com/v1";
  private geocodingUrl = "https://geocoding-api.open-meteo.com/v1/search";

  cmdHandlers: Record<string, (msg: MessageContext) => Promise<void>> = {
    weather: async (msg: MessageContext) => await this.handleWeather(msg),
  };

  private async handleWeather(msg: MessageContext): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: html("❌ <b>客户端未初始化</b>") });
      return;
    }

    try {
      const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
      const parts = lines?.[0]?.split(/\s+/) || [];
      const [, ...args] = parts;

      if (args.length === 0) {
        await msg.edit({
          text: html(
            `❌ <b>请指定城市名</b>\n\n<b>用法:</b>\n<code>${mainPrefix}weather &lt;城市名&gt;</code>\n\n<b>示例:</b>\n<code>${mainPrefix}weather 北京</code>\n<code>${mainPrefix}weather London</code>`
          ),
        });
        return;
      }

      if (args[0].toLowerCase() === "help" || args[0].toLowerCase() === "h") {
        await msg.edit({ text: html(help_text) });
        return;
      }

      let cityName = args.join(" ");
      const originalCityInput = cityName;

      await msg.edit({
        text: html(`🔍 <b>正在识别城市...</b>\n<i>${htmlEscape(originalCityInput)}</i>`),
      });

      cityName = await this.processCityName(cityName);

      if (cityName !== originalCityInput) {
        await msg.edit({
          text: html(
            `🌍 <b>正在搜索...</b>\n<i>${htmlEscape(originalCityInput)} → ${htmlEscape(cityName)}</i>`
          ),
        });
      } else {
        await msg.edit({
          text: html(`🌍 <b>正在搜索 ${htmlEscape(cityName)}...</b>`),
        });
      }

      const axios = (await import("axios")).default;

      const geoResponse = await axios.get(this.geocodingUrl, {
        params: {
          name: cityName,
          count: 10,
          language: "zh",
          format: "json",
        },
        timeout: 10000,
      });

      if (!geoResponse.data.results || geoResponse.data.results.length === 0) {
        await msg.edit({
          text: html(
            `❌ <b>城市未找到</b>\n\n无法找到城市: <code>${htmlEscape(originalCityInput)}</code>\n\n<b>💡 建议:</b>\n• 检查城市名拼写\n• 尝试使用英文名称\n• 尝试添加国家名，如: Beijing China\n\n<b>示例:</b>\n• <code>${mainPrefix}weather beijing</code>\n• <code>${mainPrefix}weather 上海</code>\n• <code>${mainPrefix}weather London</code>`
          ),
        });
        return;
      }

      const location = geoResponse.data.results[0];
      const locationParts: string[] = [];

      if (location.name && location.name !== "undefined") {
        locationParts.push(location.name);
      }
      if (
        location.admin1 &&
        location.admin1 !== "undefined" &&
        location.admin1 !== location.name
      ) {
        locationParts.push(location.admin1);
      }
      if (location.country && location.country !== "undefined") {
        locationParts.push(location.country);
      }

      const locationName = locationParts.join(", ");

      await msg.edit({
        text: html(`🌡️ <b>正在获取 ${htmlEscape(locationName)} 的天气...</b>`),
      });

      const weatherResponse = await axios.get(`${this.apiUrl}/forecast`, {
        params: {
          latitude: location.latitude,
          longitude: location.longitude,
          current:
            "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,snowfall,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
          daily:
            "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,wind_speed_10m_max",
          timezone: "auto",
          forecast_days: 1,
        },
        timeout: 10000,
      });

      const data: OpenMeteoResponse = weatherResponse.data;

      if (!data.current) {
        await msg.edit({ text: html("❌ <b>无法获取天气数据</b>") });
        return;
      }

      const weatherReport = this.buildWeatherReport(data, locationName);
      await msg.edit({ text: html(weatherReport) });
    } catch (error: unknown) {
      logger.error("[weather] 插件执行失败:", error);
      const err = error as { code?: string; message?: string };
      if (
        err.code === "ECONNABORTED" ||
        err.code === "ETIMEDOUT" ||
        getErrorMessage(error).includes("timeout")
      ) {
        await msg.edit({
          text: html(`❌ <b>请求超时</b>\n\n网络连接缓慢，请稍后重试`),
        });
        return;
      }

      await msg.edit({
        text: html(
          `❌ <b>查询失败</b>\n\n${htmlEscape(getErrorMessage(error) || "未知错误")}\n\n请检查网络连接或稍后重试`
        ),
      });
    }
  }

  private async processCityName(cityName: string): Promise<string> {
    const quickMap: Record<string, string> = {
      北京: "Beijing",
      上海: "Shanghai",
      广州: "Guangzhou",
      深圳: "Shenzhen",
      成都: "Chengdu",
      杭州: "Hangzhou",
      武汉: "Wuhan",
      西安: "Xi'an",
      重庆: "Chongqing",
      南京: "Nanjing",
      天津: "Tianjin",
      苏州: "Suzhou",
      长沙: "Changsha",
      郑州: "Zhengzhou",
      青岛: "Qingdao",
      大连: "Dalian",
      厦门: "Xiamen",
      香港: "Hong Kong",
      澳门: "Macau",
      台北: "Taipei",
      东京: "Tokyo",
      大阪: "Osaka",
      京都: "Kyoto",
      首尔: "Seoul",
      釜山: "Busan",
      曼谷: "Bangkok",
      新加坡: "Singapore",
      吉隆坡: "Kuala Lumpur",
      雅加达: "Jakarta",
      马尼拉: "Manila",
      河内: "Hanoi",
      胡志明市: "Ho Chi Minh City",
      迪拜: "Dubai",
      新德里: "New Delhi",
      孟买: "Mumbai",
      伦敦: "London",
      巴黎: "Paris",
      柏林: "Berlin",
      罗马: "Rome",
      马德里: "Madrid",
      巴塞罗那: "Barcelona",
      阿姆斯特丹: "Amsterdam",
      莫斯科: "Moscow",
      纽约: "New York",
      洛杉矶: "Los Angeles",
      旧金山: "San Francisco",
      芝加哥: "Chicago",
      华盛顿: "Washington",
      波士顿: "Boston",
      西雅图: "Seattle",
      多伦多: "Toronto",
      温哥华: "Vancouver",
      悉尼: "Sydney",
      墨尔本: "Melbourne",
      奥克兰: "Auckland",
      惠灵顿: "Wellington",
    };

    if (quickMap[cityName]) {
      logger.info(`[weather] 使用快速映射: ${cityName} -> ${quickMap[cityName]}`);
      return quickMap[cityName];
    }

    if (!/[\u4e00-\u9fa5]/.test(cityName)) {
      return cityName;
    }

    try {
      logger.info(`[weather] 正在翻译中文地名: ${cityName}`);
      const translateModule = await import("@vitalets/google-translate-api");
      const translate =
        (translateModule as { translate?: Function; default?: Function }).translate ||
        (translateModule as { default?: Function }).default;

      if (!translate || typeof translate !== "function") {
        logger.error("[weather] 翻译服务未正确加载");
        return cityName;
      }

      const result = await translate(cityName, { to: "en", timeout: 5000 });
      const translated = result?.text || result;

      if (!translated || typeof translated !== "string" || translated.trim() === "") {
        logger.error("[weather] 翻译结果为空");
        return cityName;
      }

      logger.info(`[weather] 翻译成功: ${cityName} -> ${translated}`);
      return translated.trim();
    } catch (error: unknown) {
      logger.error(`[weather] 翻译失败，使用原始输入: ${getErrorMessage(error)}`);
      return cityName;
    }
  }

  private buildWeatherReport(data: OpenMeteoResponse, locationName: string): string {
    const current = data.current!;
    const daily = data.daily!;

    const weatherInfo =
      weatherCodeMap[current.weather_code] || { icon: "🌤️", description: "未知" };
    const windDir = calcWindDirection(current.wind_direction_10m);
    const sunrise = daily.sunrise[0].split("T")[1].substring(0, 5);
    const sunset = daily.sunset[0].split("T")[1].substring(0, 5);

    let result = `<b>📍 ${htmlEscape(locationName)}</b>\n\n`;
    result += `${weatherInfo.icon} <b>${weatherInfo.description}</b>\n\n`;
    result += `🌡️ <b>温度:</b> ${current.temperature_2m}°C\n`;
    result += `🤔 <b>体感:</b> ${current.apparent_temperature}°C\n`;
    result += `📊 <b>今日最高/最低:</b> ${daily.temperature_2m_max[0]}°C / ${daily.temperature_2m_min[0]}°C\n`;
    result += `💧 <b>湿度:</b> ${current.relative_humidity_2m}%\n`;
    result += `💨 <b>风速:</b> ${current.wind_speed_10m} km/h (${windDir}风)\n`;

    if (current.wind_gusts_10m > 0) {
      result += `🌪️ <b>阵风:</b> ${current.wind_gusts_10m} km/h\n`;
    }

    result += `🔵 <b>气压:</b> ${Math.round(current.pressure_msl)} hPa\n`;
    result += `☁️ <b>云量:</b> ${current.cloud_cover}%\n`;

    if (current.precipitation > 0) {
      result += `🌧️ <b>降水量:</b> ${current.precipitation} mm\n`;
    }
    if (current.rain > 0) {
      result += `☔ <b>降雨量:</b> ${current.rain} mm\n`;
    }
    if (current.snowfall > 0) {
      result += `❄️ <b>降雪量:</b> ${current.snowfall} cm\n`;
    }

    result += `🌅 <b>日出:</b> ${sunrise}\n`;
    result += `🌇 <b>日落:</b> ${sunset}\n\n`;

    const warnings = this.checkWeatherWarnings(current, daily);
    if (warnings.length > 0) {
      result += `<b>⚠️ 天气提醒</b>\n`;
      for (const warning of warnings) {
        result += `${warning}\n`;
      }
      result += `\n`;
    }

    result += `<i>数据来源: Open-Meteo (免费API)</i>`;
    return result;
  }

  private checkWeatherWarnings(
    current: NonNullable<OpenMeteoResponse["current"]>,
    daily: NonNullable<OpenMeteoResponse["daily"]>
  ): string[] {
    const warnings: string[] = [];

    if (current.temperature_2m > 35) {
      warnings.push(`🔥 高温预警：${current.temperature_2m}°C`);
    } else if (current.temperature_2m < -10) {
      warnings.push(`❄️ 低温预警：${current.temperature_2m}°C`);
    }

    if (current.wind_speed_10m > 40) {
      warnings.push(`💨 大风预警：风速 ${current.wind_speed_10m} km/h`);
    }

    if (current.precipitation > 10) {
      warnings.push(`🌧️ 强降水预警：${current.precipitation} mm`);
    }

    const code = current.weather_code;
    if (code >= 95 && code <= 99) {
      warnings.push(`⛈️ 雷暴预警：请注意安全`);
    } else if (code >= 71 && code <= 77) {
      warnings.push(`🌨️ 降雪预警：路面可能结冰`);
    } else if (code === 45 || code === 48) {
      warnings.push(`🌫️ 大雾预警：能见度低`);
    }

    // silence unused daily param warning while keeping signature aligned with teleproto
    void daily;
    return warnings;
  }

  cleanup(): void {
    // no-op
  }
}

export default new WeatherPlugin();
