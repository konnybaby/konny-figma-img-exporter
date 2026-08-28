# Konny Image Exporter — 로컬 저장 헬퍼
#
# Figma 플러그인은 파일을 디스크에 직접 쓸 수 없다. 이 스크립트를 켜두면
# 플러그인이 127.0.0.1 로 이미지를 보내고, 여기서 지정한 폴더에 바로 저장한다.
# 저장 창이 뜨지 않고 개수 제한도 없다.
#
# Windows에 기본 내장된 PowerShell만 쓰므로 따로 설치할 것이 없다.
# 실행: 「내보내기 서버 실행.bat」 더블클릭

param(
  [int]$Port = 8787,
  [string]$Folder = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# 이 확장자만 저장한다. 로컬 서버는 아무 웹페이지나 접근할 수 있으므로
# 실행 파일 등이 떨어지지 않도록 막아 둔다.
$AllowedExt = @(".png", ".jpg", ".jpeg", ".svg", ".pdf", ".zip")

$ConfigDir  = Join-Path $env:APPDATA "konny-export-server"
$ConfigPath = Join-Path $ConfigDir "folder.txt"

# ------------------------------------------------------------------ 폴더 선택

function Select-OutputFolder {
  $last = ""
  if (Test-Path $ConfigPath) {
    try { $last = (Get-Content $ConfigPath -Raw -Encoding UTF8).Trim() } catch { $last = "" }
  }

  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "내보낸 이미지를 저장할 폴더를 선택하세요"
  $dialog.ShowNewFolderButton = $true
  if ($last -and (Test-Path $last)) { $dialog.SelectedPath = $last }

  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return "" }
  return $dialog.SelectedPath
}

if (-not $Folder) { $Folder = Select-OutputFolder }
if (-not $Folder) {
  Write-Host "폴더를 선택하지 않아 종료합니다." -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path $Folder)) { New-Item -ItemType Directory -Path $Folder -Force | Out-Null }
if (-not (Test-Path $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null }
Set-Content -Path $ConfigPath -Value $Folder -Encoding UTF8

# -------------------------------------------------------------------- 유틸

function Get-SafeFileName([string]$raw) {
  if (-not $raw) { return "" }
  # 경로 요소를 모두 떼어내 폴더 밖으로 나가지 못하게 한다.
  $name = [IO.Path]::GetFileName($raw)
  if (-not $name -or $name -eq "." -or $name -eq "..") { return "" }
  foreach ($c in [IO.Path]::GetInvalidFileNameChars()) { $name = $name.Replace($c, '_') }
  $ext = [IO.Path]::GetExtension($name).ToLowerInvariant()
  if ($AllowedExt -notcontains $ext) { return "" }
  return $name
}

function Send-Response($stream, [string]$status, [string]$json) {
  $body = [Text.Encoding]::UTF8.GetBytes($json)
  $head = "HTTP/1.1 $status`r`n" +
          "Content-Type: application/json; charset=utf-8`r`n" +
          "Content-Length: $($body.Length)`r`n" +
          "Access-Control-Allow-Origin: *`r`n" +
          "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n" +
          "Access-Control-Allow-Headers: Content-Type`r`n" +
          "Access-Control-Max-Age: 86400`r`n" +
          "Cache-Control: no-store`r`n" +
          "Connection: close`r`n`r`n"
  $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($headBytes, 0, $headBytes.Length)
  if ($body.Length) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

function Read-Headers($stream) {
  $bytes = New-Object System.Collections.Generic.List[byte]
  $one = New-Object byte[] 1
  while ($true) {
    $n = $stream.Read($one, 0, 1)
    if ($n -le 0) { return $null }
    $bytes.Add($one[0])
    $c = $bytes.Count
    if ($c -ge 4 -and $bytes[$c-4] -eq 13 -and $bytes[$c-3] -eq 10 -and
        $bytes[$c-2] -eq 13 -and $bytes[$c-1] -eq 10) { break }
    if ($c -gt 65536) { return $null }
  }
  return [Text.Encoding]::ASCII.GetString($bytes.ToArray())
}

function Read-Body($stream, [int]$length) {
  $buffer = New-Object byte[] $length
  $read = 0
  while ($read -lt $length) {
    $n = $stream.Read($buffer, $read, $length - $read)
    if ($n -le 0) { break }
    $read += $n
  }
  if ($read -ne $length) { return $null }
  return $buffer
}

function Get-QueryValue([string]$query, [string]$key) {
  foreach ($pair in $query.Split('&')) {
    $i = $pair.IndexOf('=')
    if ($i -lt 1) { continue }
    if ($pair.Substring(0, $i) -eq $key) {
      return [Uri]::UnescapeDataString($pair.Substring($i + 1))
    }
  }
  return ""
}

# ------------------------------------------------------------------- 서버

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
try {
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "  포트 $Port 를 열지 못했습니다. 이미 서버가 켜져 있는지 확인해 주세요." -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
  Write-Host ""
  exit 1
}

Write-Host ""
Write-Host "  Konny Image Exporter — 로컬 저장 서버" -ForegroundColor White
Write-Host "  ------------------------------------------------" -ForegroundColor DarkGray
Write-Host "  저장 폴더 : $Folder"
Write-Host "  주소      : http://localhost:$Port"
Write-Host ""
Write-Host "  이 창을 열어 둔 채로 Figma 플러그인에서 [로컬 폴더] 를 쓰세요." -ForegroundColor DarkGray
Write-Host "  끄려면 이 창을 닫거나 Ctrl+C 를 누르세요." -ForegroundColor DarkGray
Write-Host ""

$saved = 0

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 15000
      $client.SendTimeout = 15000
      $stream = $client.GetStream()

      $raw = Read-Headers $stream
      if (-not $raw) { continue }

      $lines = $raw -split "`r`n"
      $parts = $lines[0] -split ' '
      if ($parts.Count -lt 2) { continue }
      $method = $parts[0]
      $target = $parts[1]

      $path = $target
      $query = ""
      $q = $target.IndexOf('?')
      if ($q -ge 0) { $path = $target.Substring(0, $q); $query = $target.Substring($q + 1) }

      $contentLength = 0
      foreach ($line in $lines) {
        if ($line -match '^(?i)content-length:\s*(\d+)\s*$') { $contentLength = [int]$Matches[1] }
      }

      if ($method -eq "OPTIONS") {
        Send-Response $stream "204 No Content" ""
        continue
      }

      if ($path -eq "/ping") {
        $info = @{ ok = $true; name = "konny-export-server"; folder = $Folder } | ConvertTo-Json -Compress
        Send-Response $stream "200 OK" $info
        continue
      }

      if ($path -eq "/save" -and $method -eq "POST") {
        $name = Get-SafeFileName (Get-QueryValue $query "name")
        if (-not $name) {
          Send-Response $stream "400 Bad Request" '{"ok":false,"error":"허용되지 않는 파일 이름입니다"}'
          continue
        }
        if ($contentLength -le 0) {
          Send-Response $stream "400 Bad Request" '{"ok":false,"error":"내용이 비어 있습니다"}'
          continue
        }

        $data = Read-Body $stream $contentLength
        if ($null -eq $data) {
          Send-Response $stream "400 Bad Request" '{"ok":false,"error":"전송이 중간에 끊겼습니다"}'
          continue
        }

        $dest = Join-Path $Folder $name
        [IO.File]::WriteAllBytes($dest, $data)
        $saved++
        Write-Host ("  [{0,3}] {1}  ({2:N0} bytes)" -f $saved, $name, $data.Length) -ForegroundColor Green

        $res = @{ ok = $true; name = $name; folder = $Folder } | ConvertTo-Json -Compress
        Send-Response $stream "200 OK" $res
        continue
      }

      Send-Response $stream "404 Not Found" '{"ok":false,"error":"알 수 없는 경로입니다"}'
    } catch {
      Write-Host "  요청 처리 중 오류: $($_.Exception.Message)" -ForegroundColor DarkYellow
    } finally {
      try { $client.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
  Write-Host ""
  Write-Host "  서버를 종료했습니다. 저장한 파일 $saved 개" -ForegroundColor DarkGray
}
