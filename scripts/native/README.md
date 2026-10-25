# Isolated native verification

Requires Node 24, PowerShell 7, official DSH `0.2.1-rc.3`, and accepted dependency tgz files. No sibling source is loaded. The checked-in harness is a test-only local model adapter and public-owner transport fixture; it is excluded from the product tarball. It never uses a paid model. Generated homes, cookies, full logs and raw evidence stay under ignored `.runtime/`.

Create an inputs JSON outside the product package with `{hostVersion:"0.2.1-rc.3",packages:[{name,version,path,sha256}]}` for Database 0.2.0, LastStep 0.3.0, this GM 0.1.0 and optional Loop 0.1.0. Exact accepted dependency hashes are in `docs/native-acceptance.md`; calculate this checkout's package SHA after `pnpm package`. The installer verifies each archive and uses a SHA-named file URL to avoid pnpm caching changed bytes at the same tarball path/version.

```powershell
pwsh -NoProfile -File scripts/native/run-basic.ps1 -RunDirectory "$PWD/.runtime/source" -InputsFile "$PWD/.runtime/inputs.json"
pwsh -NoProfile -File scripts/native/run-transfer.ps1 -SourceDirectory "$PWD/.runtime/source" -RunDirectory "$PWD/.runtime/destination" -InputsFile "$PWD/.runtime/inputs.json"
node scripts/native/ui-smoke.mjs "$PWD/.runtime/source"
pwsh -NoProfile -File scripts/native/stop-host.ps1 -RunDirectory "$PWD/.runtime/source"
pwsh -NoProfile -File scripts/native/stop-host.ps1 -RunDirectory "$PWD/.runtime/destination"
```

Use new source/destination directories for a complete run. The basic runner verifies normal first-turn opening, same-launch retry, real SDK tool-body retry, one fact batch, causal style inheritance/fork/rollback, guarded failed-writer retry and cold restart. The transfer runner captures public owner outputs under maintenance, preflights absent destinations, imports original public persistence records and inheritedEventCount, restores each owner, safely resumes without prompting, validates ready styles and activates the gate. It also rolls an imported child's inherited prefix back through the real GM service. It does not implement StoryKit's durable restore coordinator or promise arbitrary crash recovery.

UI verification uses Playwright in a new BrowserContext with extensions disabled. Set GM_NATIVE_BROWSER_PATH to a cached supported Chromium executable if the default headless1217 path is unavailable. Screenshots show the actual installed host. A transport delay holds an actual startSample response while another story is selected, proving late completion cannot steal selection. No RPC result is replaced with fabricated data.

All background hosts are hidden. stop-host verifies the recorded process/port belongs to the requested owned runtime before stopping it; persistence flush precedes shutdown. Authenticated login URLs and cookies are local test secrets, not report content.
