# dsh-shutdown-idle (English)

A DSH plugin that runs a power action once every session and background job has gone idle. Works on Windows.

## Install

```sh
dsh plugin add liaoyuqing/dsh-shutdown-idle
```

Or from source:

```sh
dsh plugin add link:/path/to/dsh-shutdown-idle
```

## What it does

Enable it in Settings → Shutdown after sessions end. The plugin samples every in-process Agent session once per second. When no session is `running`, no background job is running, and the machine stays idle for the configured window, it runs the chosen action (shutdown / restart / hibernate / sleep / lock / logoff, or `none` to only log).

A draggable card in the bottom-right shows the current phase and remaining seconds, with a Cancel button.

## Safety

- **The toggle never survives a host restart** — it always comes back off, so a reboot can never shut the machine down.
- Sessions that are `running` always count as busy; this cannot be turned off.
- If the `agents` service is unavailable, the plugin treats the machine as **busy** and never fires.
- Everything is cancellable: any session starting, or pressing Cancel, aborts the countdown.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| action | `shutdown` | `shutdown` / `restart` / `hibernate` / `sleep` / `lock` / `logoff` / `none` |
| settleSeconds | 20 | Confirm idle for this long before counting down |
| countdownSeconds | 60 | Cancellable countdown before the action runs |
| requireActivity | `true` | Require at least one observed session before firing |
| considerJobs | `true` | Count running background jobs as busy |

Initial values come from `cordis.patch.yml`; UI changes are written to `<DSH_HOME>/dsh-shutdown-idle/settings.json` and take precedence.

## Platform

Actions use the Windows built-ins `shutdown` / `rundll32`. On other platforms every action except `none` degrades to `none` and is labelled as such.

## License

MIT
