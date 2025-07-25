<a href="https://testdriver.ai"><img src="https://github.com/dashcamio/testdriver/assets/318295/2a0ad981-8504-46f0-ad97-60cb6c26f1e7"/></a>

# TestDriver.ai

Automate and scale QA with computer-use agents.

[Docs](https://docs.testdriver.ai) | [Website](https://testdriver.ai) | [GitHub Action](https://github.com/marketplace/actions/testdriver-ai) | [Join our Discord](https://discord.com/invite/cWDFW8DzPm)

# Install via NPM

[Follow the instructions on our docs for more.](https://docs.testdriver.ai/overview/quickstart).

# About

TestDriver isn't like any test framework you've used before. TestDriver is an OS Agent for QA. TestDriver uses AI vision along with mouse and keyboard emulation to control the entire desktop. It's more like a QA employee than a test framework. This kind of black-box testing has some major advantages:

- **Easier set up:** No need to add test IDs or craft complex selectors
- **Less Maintenance:** Tests don't break when code changes
- **More Power:** TestDriver can test any application and control any OS setting

### Demo (Playing Balatro Desktop)

https://github.com/user-attachments/assets/7cb9ee5a-0d05-4ff0-a4fa-084bcee12e98

# Examples

- Test any user flow on any website in any browser
- Clone, build, and test any desktop app
- Render multiple browser windows and popups like 3rd party auth
- Test `<canvas>`, `<iframe>`, and `<video>` tags with ease
- Use file selectors to upload files to the browser
- Test chrome extensions
- Test integrations between applications
- Integrates into CI/CD via GitHub Actions ($)

Check out [the docs](https://docs.testdriver.ai/).

# Workflow

1. Tell TestDriver what to do in natural language on your local machine using `npm i testdriverai -g`
2. TestDriver looks at the screen and uses mouse and keyboard emulation to accomplish the goal
3. Run TestDriver tests on our test infrastructure

# Quickstart

## Initialize TestDriver

In your project directory:

```sh
npx testdriverai@latest init
```

## Teach TestDriver a test

Let's show TestDriver what we want to test. Run the following command:

```sh
npx testdriverai@latest .testdriver/test.yaml
```

## Reset the test state

TestDriver best practice is to start instructing TestDriver with your app in it's initial state. For browsers, this means creating a new tab with the website you want to test.

If you have multiple monitors, make sure you do this on your primary display.

## Instruct TestDriver

Now, just tell TestDriver what you want it to do. For now, stick with single commands like "click sign up" and "scroll down."

Later, try to perform higher level objectives like "complete the onboarding."

```yaml
> Click on sign up
TestDriver Generates a Test
TestDriver will look at your screen and generate a test script. TestDriver can see the screen, control the mouse, keyboard, and more!
TestDriver can only see your primary display!
To navigate to testdriver.ai, we need to focus on the
Google Chrome application, click on the search bar, type
the URL, and then press Enter.

Here are the steps:

1. Focus on the Google Chrome application.
2. Click on the search bar.
3. Type "testdriver.ai".
4. Press Enter.

Let's start with focusing on the Google Chrome application
and clicking on the search bar.

commands:
  - command: focus-application
    name: Google Chrome
  - command: hover-text
    text: Search Google or type a URL
    description: main google search
    action: click

After this, we will type the URL and press Enter.
```

## TestDriver executes the test script

TestDriver will execute the commands found in the yml codeblocks of the response.

See the yml TestDriver generated? That's our own schema. You can learn more about it in the [reference](https://docs.testdriver.ai/getting-started/editing).

> Take your hands off the mouse and keyboard while TestDriver executes! TestDriver is not a fan of backseat drivers.

## Keep going!

Feel free to ask TestDriver to perform some more tasks. Every time you prompt TestDriver it will look at your screen and generate more test step to complete your goal.

```sh
> navigate to airbnb.com
> search for destinations in austin tx
> click check in
> select august 8
```

If something didn't work, you can use `/undo` to remove all of the test steps added since the last prompt.

## Test the test locally

Now it's time to make sure the test plan works before we deploy it. Use testdriver run to run the test file you just created with /save .

```sh
npx testdriverai@latest run testdriver/test.yaml
```

Make sure to reset the test state!

## Deploy

Now it's time to deploy your test using our GitHub action! `testdriver init` already did the work for you and will start triggering tests once you commit the new files to your repository.

```sh
git add .
git commit -am "Add TestDriver tests"
gh pr create --web
```

Your test will run on every commit and the results will be posted as a Dashcam.io video within your GitHub summary! Learn more about deploying on CI [here](https://docs.testdriver.ai/action/setup).

## Using as a Module

TestDriver can also be used programmatically as a Node.js module. This is useful when you want to integrate TestDriver into your own applications or customize the test file paths.

### Custom Test File Paths

By default, TestDriver looks for test files at `testdriver/testdriver.yaml` relative to the current working directory. You can customize this:

```javascript
const TestDriverAgent = require("testdriverai");

// Option 1: Set default via environment variable
const agent1 = new TestDriverAgent({
  TD_DEFAULT_TEST_FILE: "my-tests/integration.yaml",
});

// Option 2: Explicitly specify test file
const agent2 = new TestDriverAgent(
  {},
  {
    args: ["path/to/specific/test.yaml"],
  },
);

// Option 3: Custom working directory + relative path
const agent3 = new TestDriverAgent(
  { TD_DEFAULT_TEST_FILE: "tests/smoke.yaml" },
  { options: { workingDir: "/path/to/your/project" } },
);

// Run the test
await agent1.run();
```

### Environment Variables

You can also set the default test file path using environment variables:

```bash
export TD_DEFAULT_TEST_FILE="custom/path/test.yaml"
node your-script.js
```
