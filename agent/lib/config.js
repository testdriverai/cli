/**
 * This file contains application config.
 * It is responsible for loading the config from env,
 * supplying defaults, and formatting values
 */

// Load the env vars from .env
require("dotenv").config();

// Parse out true and false string values
function parseValue(value) {
  if (typeof value === "string") {
    const normalizedValue = value.toLowerCase().trim();
    if (["true", "false"].includes(normalizedValue)) {
      return JSON.parse(normalizedValue);
    }
  }

  return value;
}

const config = {
  TD_ANALYTICS: true,
  TD_API_ROOT: "https://testdriverai-v6-c96fc597be11.herokuapp.com",
  TD_API_KEY: null,
  TD_PROFILE: false,
  TD_RESOLUTION: [1366, 768],
};

// Find all env vars starting with TD_
for (let key in process.env) {
  if (key == "TD_RESOLUTION") {
    config[key] = process.env[key].split("x").map((x) => parseInt(x.trim()));
    continue;
  }

  if (key.startsWith("TD_")) {
    config[key] = parseValue(process.env[key]);
  }
}

module.exports = config;
