# verify.ps1
# 校验本目录下所有 .bat / .ps1 是否符合编码规范：
#   .bat : 纯 ASCII + 无 BOM + CRLF（无孤立 LF）
#   .ps1 : UTF-8 + BOM + CRLF
# 用法: powershell -File verify.ps1 [-TargetDir <DIR>]
param(
    [string]$TargetDir = $PSScriptRoot
)

$utf8Bom = [byte[]](0xEF, 0xBB, 0xBF)
$gbk = [System.Text.Encoding]::GetEncoding(936)
$pass = 0; $fail = 0

function Test-Encoding {
    param($path, $expectedEncoding, $expectBom)
    $b = [System.IO.File]::ReadAllBytes($path)
    $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    $issues = @()
    if ($expectBom -and -not $hasBom) { $issues += 'Missing BOM' }
    if (-not $expectBom -and $hasBom) { $issues += 'Unexpected BOM' }
    $lf = 0
    for ($i = 0; $i -lt $b.Length; $i++) {
        if ($b[$i] -eq 0x0A -and ($i -eq 0 -or $b[$i-1] -ne 0x0D)) { $lf++ }
    }
    if ($lf -gt 0) { $issues += "$lf orphan LF" }
    if ($expectedEncoding -eq 'ASCII') {
        $nonAscii = 0
        foreach ($byte in $b) { if ($byte -gt 127) { $nonAscii++ } }
        if ($nonAscii -gt 0) { $issues += "$nonAscii non-ASCII bytes" }
    }
    return @{ issues = $issues; hasBom = $hasBom }
}

Write-Host "校验目录：$TargetDir" -ForegroundColor Yellow
Get-ChildItem $TargetDir -Filter '*.bat' -Recurse | ForEach-Object {
    $r = Test-Encoding $_.FullName 'ASCII' $false
    if ($r.issues.Count -eq 0) { Write-Host "[PASS] $($_.Name)" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "[FAIL] $($_.Name): $($r.issues -join ', ')" -ForegroundColor Red; $script:fail++ }
}
Get-ChildItem $TargetDir -Filter '*.ps1' -Recurse | ForEach-Object {
    $r = Test-Encoding $_.FullName 'UTF8' $true
    if ($r.issues.Count -eq 0) { Write-Host "[PASS] $($_.Name)" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "[FAIL] $($_.Name): $($r.issues -join ', ')" -ForegroundColor Red; $script:fail++ }
}
Write-Host ""
Write-Host ("Total: $pass PASS, $fail FAIL") -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
exit $(if ($fail -eq 0) { 0 } else { 1 })
