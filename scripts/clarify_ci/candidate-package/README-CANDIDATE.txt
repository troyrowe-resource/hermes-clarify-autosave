HERMES CLARIFY-AUTOSAVE CANDIDATE @SHA7@
=========================================

UNSIGNED. PRIVATE. NOT AN OFFICIAL HERMES RELEASE.

This is a one-commit test build of Hermes Desktop that preserves unfinished
clarification text and choices through timeout, reconnect and restart. It is
built from source commit

    @COMMIT@

by    @RUN_URL@

Confirm remains the only submission action: a saved or recalled draft is never
sent to the assistant and never grants approval.

START
-----
Double-click  Start-HermesClarifyCandidate.cmd

That is the only supported way to start it. It creates one disposable sandbox,
by default

    %LOCALAPPDATA%\HermesClarifyCandidate

holding the candidate's Hermes home, Electron user data, a private user
profile, the folder the assistant works in (workspace) and a temp folder. It
REFUSES to start if that folder would be, sit inside, or contain any real
Hermes location of yours (default home, legacy home, the installed app's user
data or updater cache, any HERMES_HOME you or the machine have set), whether
the path says so or only a junction, link or substituted drive does. It also
refuses an executable that does not match the sha256 in MANIFEST.json. It does
not re-hash the rest of the package at every start (that takes minutes): see
VERIFY THE DOWNLOAD.

What it does not touch: an installed Hermes app, its updater, its data, its
backend, the hermes:// handler, your PATH. The candidate has its own product
identity (Hermes Agent @SHA7@, hermes-@SHA7@.exe) and its own updater is switched
off by its build stamp ("This build doesn't get updates").

It starts with no provider configured. Add one inside the candidate, or connect
it to a server, exactly as you would a fresh Hermes. Nothing is copied from
your real Hermes.

Do not start app\@EXE_NAME@ directly. A direct start is contained, not
isolated. The build keeps to its own data folders (Electron user data
%APPDATA%\HermesBundledCommit@SHA7@-clarify-candidate, next to an
empty %APPDATA%\HermesBundledCommit@SHA7@; Hermes home
%LOCALAPPDATA%\hermes-clarify-candidate, which also holds its gateway's lock
and record folder), cannot update itself, never reads an exported or saved
HERMES_HOME and never registers the hermes:// link handler. But those folders
are in your real profile instead of the sandbox, the programs it starts see
your real user profile, and the assistant's default working folder is your user
profile folder. Only the launcher gives it a profile of its own.

STOP
----
Closing the window leaves the candidate's background gateway running (Hermes
Desktop never stops it). Run  Stop-HermesClarifyCandidate.cmd  to end it. It
only ever ends processes that run from THIS folder, it also works after a
direct start of the .exe, and it never asks you anything: it exits with an
error only if something of the candidate is still running afterwards.

RESET
-----
Run Stop, then delete the sandbox folder. Nothing else holds state.

VERIFY THE DOWNLOAD
-------------------
MANIFEST.json (here and beside the zip) records the source commit, the run, the
sha256 of the zip and of @EXE@, the runtime prerequisites and the signing
status. FILES.sha256 lists the sha256 of every other file in this folder:

    certutil -hashfile app\hermes-@SHA7@.exe SHA256

To check EVERY file against FILES.sha256 (a few minutes), run this in this
folder. It prints a line for each file that differs or is missing, and nothing
when they all match:

    powershell -NoProfile -Command "Get-Content -Encoding UTF8 FILES.sha256 | ForEach-Object { $h, $p = $_ -split '  ', 2; if (-not (Test-Path -LiteralPath $p) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash -ne $h) { 'DIFFERS: ' + $p } }"

SMARTSCREEN
-----------
The executable is unsigned, so Windows will warn. Unblock the zip (right-click,
Properties, Unblock) before extracting, then start through the .cmd file.

REQUIREMENTS
------------
Windows on x64. It was started only on a Windows Server 2025 runner (build
26100); the project's own installer floor is Windows 11 22H2 and nothing older
was tried. No Python, Node, Git or Hermes install is needed: the runtime ships
under app\resources\agent-payload. Free disk of about twice the zip size.
Network only for what you configure.

KNOWN LIMITS
------------
This is a build-and-test candidate. Continuous-integration success on a clean
GitHub-hosted Windows runner is not proof that it works with your particular
laptop, your server or your installed update path; those remain a separate,
explicit step. The workflow run named above lists exactly which scenarios were
exercised and what remains unsupported.
