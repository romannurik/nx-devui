# Dev UI for `nx`

Starts up a terminal-based multiplexed log UI for when you have multiple
dev servers and watch processes to start up in your monorepo.

## Usage

First install with

```shell
npm install nx-devui
```

Then, assuming you want the `dev` and `watch` scripts to run in all projects, add this to your `project.json` (typically at the root level):

```json
{
  "targets": {
    "dev": {
      "executor": "nx-devui:devui",
      "options": {
        "targets": {
          "dev": true,
          "watch": true
        }
      }
    }
  }
}
```

You can also show checkmark, error, or loading icons based on `stdout` or `stderr` output with "status matchers", which you can also customize per project, e.g.:

```json
{
  "targets": {
    "dev": {
      "executor": "nx-devui:devui",
      "options": {
        "targets": {
          "dev": true,
          "foo:dev": {
            "statusMatchers": {
              "Server listening on port": "success",
              "restarting due to changes": "loading",
              "app crashed": "error"
            }
          }
        }
      }
    }
  }
}
```

After defining the `dev` target like above, you can then start the UI with:

```shell
nx dev
```