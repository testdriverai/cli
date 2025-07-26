const chai = require("chai");
const expect = chai.expect;
const { createConfig } = require("../agent/lib/config");

describe("Config CI Environment Variable", function () {
  it("should set CI to true when CI environment variable is 'true'", function () {
    const environment = { CI: "true" };
    const config = createConfig(environment);
    expect(config.CI).to.equal(true);
  });

  it("should set CI to false when CI environment variable is 'false'", function () {
    const environment = { CI: "false" };
    const config = createConfig(environment);
    expect(config.CI).to.equal(false);
  });

  it("should set CI to true when CI environment variable is 'TRUE'", function () {
    const environment = { CI: "TRUE" };
    const config = createConfig(environment);
    expect(config.CI).to.equal(true);
  });

  it("should set CI to the string value when CI environment variable is not 'true' or 'false'", function () {
    const environment = { CI: "1" };
    const config = createConfig(environment);
    expect(config.CI).to.equal("1");
  });

  it("should not set CI when CI environment variable is not present", function () {
    const environment = {};
    const config = createConfig(environment);
    expect(config.CI).to.be.undefined;
  });

  it("should parse CI alongside TD_ variables", function () {
    const environment = {
      CI: "true",
      TD_API_KEY: "test-key",
      TD_ANALYTICS: "false",
    };
    const config = createConfig(environment);
    expect(config.CI).to.equal(true);
    expect(config.TD_API_KEY).to.equal("test-key");
    expect(config.TD_ANALYTICS).to.equal(false);
  });
});
