# sync-to-card.ps1 - refresh the SD card with the LATEST memory / persona / config
# from the machine you are currently running on.
#
# Run it on the "home" machine whenever 大肥鱼 has learned something new and you want
# the card to carry it away. It is a one-way mirror: machine -> card. Never deletes
# anything on the machine.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File sync-to-card.ps1 -CardRoot E:\DSH
#
# Default CardRoot is E:\DSH. Only the small, meaningful bits are copied
# (browser profile / caches / node_modules are skipped on purpose).

param(
  [string]$CardRoot = 'E:\DSH'
)

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
function Say($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

if (-not (Test-Path -LiteralPath (Join-Path $CardRoot '.dsh'))) {
  Write-Host "[X] $CardRoot\.dsh not found - is the card plugged in and the stack copied?"
  exit 1
}

$srcHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$dstHome = Join-Path $CardRoot '.dsh'
Say "machine DSH_HOME = $srcHome"
Say "card    DSH_HOME = $dstHome"

# robocopy: /E mirror tree, /R:1 retry once, /XD to skip junk, /XO only copy newer
$common = @('/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/XO', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:4')

function CopyTree($src, $dst, [string[]]$extra, $label) {
  if (-not (Test-Path -LiteralPath $src)) { Say "  skip $label (missing on machine)"; return }
  Say "  sync $label"
  $argv = @($src, $dst) + $common + $extra
  $p = Start-Process -FilePath 'robocopy.exe' -ArgumentList $argv -Wait -PassThru -NoNewWindow
  if ($p.ExitCode -ge 8) { Say "  [WARN] $label robocopy exit=$($p.ExitCode)" }
}

# 1) memory + persona + usage state of the douyin browser plugin (skip the 475 MB browser profile)
$db = Join-Path $srcHome 'douyin-browser'
CopyTree (Join-Path $db 'memory') (Join-Path $dstHome 'douyin-browser\memory') @() 'douyin memory (persona, sqlite, reports)'
CopyTree (Join-Path $db 'state')  (Join-Path $dstHome 'douyin-browser\state')  @() 'douyin state'
if (Test-Path (Join-Path $db 'dm-share-receipts.json')) {
  Copy-Item (Join-Path $db 'dm-share-receipts.json') (Join-Path $dstHome 'douyin-browser\dm-share-receipts.json') -Force
  Say '  sync dm-share-receipts.json'
}

# 2) chat sessions + storages (what 大肥鱼 remembers of your conversations)
CopyTree (Join-Path $srcHome 'sessions')  (Join-Path $dstHome 'sessions')  @() 'DSH sessions'
CopyTree (Join-Path $srcHome 'storages')  (Join-Path $dstHome 'storages')  @() 'DSH storages'

# 3) credentials / profile tweaks
foreach ($f in @('.credentials.yaml', '.dshw-usage.json')) {
  $s = Join-Path $srcHome $f
  if (Test-Path -LiteralPath $s) { Copy-Item $s (Join-Path $dstHome $f) -Force; Say "  sync $f" }
}
foreach ($f in @('cordis.patch.yml', 'package.json')) {
  $s = Join-Path $srcHome "profiles\web\$f"
  if (Test-Path -LiteralPath $s) { Copy-Item $s (Join-Path $dstHome "profiles\web\$f") -Force; Say "  sync profiles\web\$f" }
}

# 4) shared memory + QQ persona in the workspace
foreach ($rel in @('workspace\shared', 'workspace\qq-bridge\roles')) {
  $s = Join-Path $CardRoot $rel
  $machineWs = if ($env:MACHINE_WORKSPACE) { $env:MACHINE_WORKSPACE } else { Split-Path -Parent $PSScriptRoot }
  $m = switch ($rel) {
    'workspace\shared'        { Join-Path $machineWs 'shared' }
    'workspace\qq-bridge\roles' { Join-Path $machineWs 'qq-bridge\roles' }
  }
  CopyTree $m $s @() $rel
}

Say ''
# The config we just copied still points at THIS machine's paths; re-portablise it
# (and re-apply portable-strip.txt, so anything intentionally disabled on the card
# does not come back through a sync).
$cardNode = Join-Path $CardRoot 'node\node.exe'
$cardRepath = Join-Path $CardRoot 'portable-repath.mjs'
if ((Test-Path -LiteralPath $cardNode) -and (Test-Path -LiteralPath $cardRepath)) {
  Say 're-running portable-repath.mjs on the card'
  & $cardNode $cardRepath
} else {
  Say '[WARN] card node/repath missing - run start-dsh.bat once on the card to fix paths'
}

Say ''
Say '=== DONE - card now carries the latest memory/persona ==='
Say "Remember: the card config paths may need re-pointing, so just start with start-dsh.bat"
Say "which runs portable-repath.mjs automatically."
