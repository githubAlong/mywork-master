<#
  隧道地址自动同步（免域名方案）

  背景：本地 Quick Tunnel 每次重启都会换一个 *.trycloudflare.com 域名，
  线上静态页里写死的后端地址因而失效。

  做法：读取 tunnel-master.err.log 里最新的隧道地址，与线上配置比较；
  若发生变化且新地址可用，就在 master 之上生成一个只改
  js/environment-config.mjs（生产 backendUrl）和 sw.js（缓存版本）的提交并推送，
  GitHub Pages 随之自动重新发布，全程无需人工介入。

  由 workbench-supervisor.ps1 每 10 秒调用一次；地址未变时立即返回，不产生网络请求。
#>

$ErrorActionPreference = 'Continue'

$repo      = 'j:\chatgpt\jsgzt\my-workbench-master\.publish-repo.git'
$runtime   = 'F:\sql\workbench-runtime'
$logFile   = Join-Path $runtime 'tunnel-master.err.log'
$stateFile = Join-Path $env:TEMP 'wb-tunnel-url.state'
$logOut    = Join-Path $env:TEMP 'wb-publish-tunnel.log'
$remote    = 'git@github.com:githubAlong/mywork-master.git'

function Write-Note($msg) {
  try { Add-Content -LiteralPath $logOut -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding utf8 } catch {}
}

# 原样取出仓库里的文件内容（保留行尾，避免产生无意义的整文件差异）
function Read-Blob($path) {
  $out = Join-Path $env:TEMP ("wb-blob-" + [guid]::NewGuid().ToString('N'))
  Start-Process -FilePath 'git' -ArgumentList @("--git-dir=$repo", 'show', "master:$path") -RedirectStandardOutput $out -NoNewWindow -Wait | Out-Null
  if (-not (Test-Path $out)) { return $null }
  $text = [IO.File]::ReadAllText($out, [Text.Encoding]::UTF8)
  Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  if (-not $text) { return $null }
  return $text
}

if (-not (Test-Path $logFile)) { return }
$text = Get-Content -LiteralPath $logFile -Raw -ErrorAction SilentlyContinue
if (-not $text) { return }

$found = [regex]::Matches($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
if ($found.Count -eq 0) { return }
$url = $found[$found.Count - 1].Value
if (-not $url) { return }

# 地址没变就直接返回，避免每 10 秒都去碰 git
if (Test-Path $stateFile) {
  $last = (Get-Content -LiteralPath $stateFile -Raw -ErrorAction SilentlyContinue)
  if ($last -and $last.Trim() -eq $url) { return }
}

# 新地址先确认真的能用，避免把启动中的地址推上线
$alive = $false
try {
  Invoke-WebRequest -Uri "$url/rest/v1/attendance_tables?select=id&limit=1" -TimeoutSec 8 -UseBasicParsing | Out-Null
  $alive = $true
} catch {
  if ($_.Exception.Response) { $alive = $true }
}
if (-not $alive) { Write-Note "new tunnel not ready: $url"; return }

$env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=15'

if (-not (Test-Path $repo)) {
  git clone --quiet --bare $remote $repo 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Note 'clone failed'; return }
}

git --git-dir=$repo fetch --quiet origin "+refs/heads/master:refs/heads/master" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Note 'fetch failed'; return }

$envText = Read-Blob 'js/environment-config.mjs'
if (-not $envText) { Write-Note 'read env config failed'; return }

# 只替换 production 段的 backendUrl（名字后面的第一个 backendUrl）
$newEnv = [regex]::Replace($envText, "(name:\s*'production'[\s\S]{0,400}?backendUrl:\s*')https://[^']+(')", {
    param($m)
    $m.Groups[1].Value + $url + $m.Groups[2].Value
  })
if ($newEnv -eq $envText) {
  Set-Content -LiteralPath $stateFile -Value $url -Encoding ascii
  return
}

$swText = Read-Blob 'sw.js'
if (-not $swText) { Write-Note 'read sw.js failed'; return }
$stamp = Get-Date -Format 'yyyyMMddHHmm'
$newSw = $swText -replace "const CACHE = '[^']*'", "const CACHE = 'wb-$stamp-tunnel-follow'"

$tmpDir = Join-Path $env:TEMP ('wb-publish-' + $PID)
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$envPath = Join-Path $tmpDir 'environment-config.mjs'
$swPath = Join-Path $tmpDir 'sw.js'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($envPath, $newEnv, $utf8)
[IO.File]::WriteAllText($swPath, $newSw, $utf8)

$b1 = (git --git-dir=$repo hash-object -w --no-filters $envPath 2>$null | Select-Object -First 1)
$b2 = (git --git-dir=$repo hash-object -w --no-filters $swPath 2>$null | Select-Object -First 1)
if (-not $b1 -or -not $b2) { Write-Note 'hash-object failed'; return }

# 用临时索引在 master 之上拼一个干净提交，不碰任何工作区、也不带入其他人的未提交改动
$idx = Join-Path $tmpDir 'index'
$env:GIT_INDEX_FILE = $idx
git --git-dir=$repo read-tree master 2>&1 | Out-Null
git --git-dir=$repo update-index --add --cacheinfo "100644,$b1,js/environment-config.mjs" 2>&1 | Out-Null
git --git-dir=$repo update-index --add --cacheinfo "100644,$b2,sw.js" 2>&1 | Out-Null
$tree = (git --git-dir=$repo write-tree 2>$null | Select-Object -First 1)
if (-not $tree) { Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue; Write-Note 'write-tree failed'; return }
$msg = "chore(env): 自动跟随隧道地址 $url"
$commit = (git --git-dir=$repo commit-tree $tree -p master -m $msg 2>$null | Select-Object -First 1)
Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
if (-not $commit) { Write-Note 'commit-tree failed'; return }

git --git-dir=$repo push --quiet origin "${commit}:refs/heads/master" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Note "push failed: $url"; return }

Set-Content -LiteralPath $stateFile -Value $url -Encoding ascii
Write-Note "published $url as $commit"
