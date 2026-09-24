# Start Mineral on this machine: the database, the analytics service, the web app.
#
#   pnpm local
#
# Each piece starts only if it is not already up, so running this twice is
# harmless. Analytics and web open in windows of their own, so closing the one
# that ran this -- or the logoff that killed everything last time -- is the
# only thing that stops them. The database is a native cluster, not a Windows
# service, so after a reboot this is how it comes back; it recovers on its own
# from being killed mid-write.
#
# Written for Windows PowerShell 5.1 as well as 7, since that is what
# `powershell` resolves to from a pnpm script.

param(
  [string]$DataDir = "$env:USERPROFILE\mineral-pgdata",
  [int]$Port = 55432
)
# No ErrorActionPreference = 'Stop': under 5.1 it turns anything pg_ctl writes
# to stderr into a terminating error, which would replace the messages below.
$repo = Split-Path -Parent $PSScriptRoot

$pgCtl = Get-Command pg_ctl -ErrorAction SilentlyContinue
$pgCtl = if ($pgCtl) { $pgCtl.Source } else { 'C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe' }

function Listening([int]$port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# The log lives beside the data directory, not in it: crash recovery fsyncs
# every file in the data directory, and a log pg_ctl holds open there stalls it
# for thirty seconds on a sharing violation.
& $pgCtl status -D $DataDir *> $null
switch ($LASTEXITCODE) {
  0 { "database   already running" }
  3 {
    "database   starting (recovery after an unclean stop can take a minute)"
    # Not `& pg_ctl start`: the server pg_ctl leaves running inherits whatever
    # handles it was given, and PowerShell waits for EOF on them, so the call
    # never returns. A hidden window of its own gives it nothing to inherit,
    # and waiting on pg_ctl alone -- not -Wait, which waits for the server too
    # -- returns once -w says it is ready.
    $start = Start-Process $pgCtl -WindowStyle Hidden -PassThru -ArgumentList @(
      'start', '-D', "`"$DataDir`"", '-o', "`"-p $Port`"", '-l', "`"$DataDir.log`"", '-w')
    $null = $start.Handle  # cached now, or ExitCode reads as null after exit
    $start.WaitForExit()
    if ($start.ExitCode -ne 0) { throw "the database did not start; see $DataDir.log" }
  }
  default { throw "no database cluster at $DataDir; pass -DataDir, or see the README" }
}

$shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
foreach ($service in @(
    @{ Name = 'analytics'; Port = 8000 },
    @{ Name = 'web'; Port = 3000 })) {
  if (Listening $service.Port) {
    "{0,-10} already running on {1}" -f $service.Name, $service.Port
    continue
  }
  "{0,-10} starting on {1}" -f $service.Name, $service.Port
  Start-Process $shell -WorkingDirectory $repo -ArgumentList '-NoExit', '-Command', "pnpm $($service.Name)"
}

"`nMineral: http://localhost:3000"
