# ============================================================
#  Aquiete — envio via FTP para a Hostinger
#
#  COMO USAR
#  1. Pegue os dados em: hPanel > Arquivos > Contas de FTP
#  2. Clique com o botao direito neste arquivo > "Executar com o PowerShell"
#     (ou abra o PowerShell na pasta e rode:  .\subir.ps1 )
#  3. Cole host, usuario e senha quando pedir
#
#  A senha e digitada aqui no seu PC e nao fica salva em lugar nenhum.
# ============================================================

$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  Envio do site Aquiete para a Hostinger" -ForegroundColor Magenta
Write-Host "  ---------------------------------------" -ForegroundColor DarkGray
Write-Host ""

$ftpHost = Read-Host "  Host FTP (ex: ftp.aquieteagora.com.br)"
$user    = Read-Host "  Usuario FTP"
$secure  = Read-Host "  Senha FTP" -AsSecureString
$pass    = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
             [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

$ftpHost = $ftpHost -replace '^ftp://', '' -replace '/+$', ''
$root    = "ftp://$ftpHost/public_html"
$cred    = New-Object System.Net.NetworkCredential($user, $pass)

function New-FtpDir([string]$url) {
  try {
    $r = [System.Net.FtpWebRequest]::Create($url)
    $r.Credentials = $cred
    $r.Method = [System.Net.WebRequestMethods+Ftp]::MakeDirectory
    $r.UsePassive = $true
    $r.GetResponse().Close()
  } catch { }   # ja existe: segue o jogo
}

function Send-FtpFile([string]$local, [string]$remote) {
  $r = [System.Net.FtpWebRequest]::Create($remote)
  $r.Credentials = $cred
  $r.Method = [System.Net.WebRequestMethods+Ftp]::UploadFile
  $r.UseBinary = $true
  $r.UsePassive = $true
  $r.KeepAlive = $false

  $bytes = [System.IO.File]::ReadAllBytes($local)
  $r.ContentLength = $bytes.Length
  $s = $r.GetRequestStream()
  $s.Write($bytes, 0, $bytes.Length)
  $s.Close()
  $resp = $r.GetResponse()
  $resp.Close()
  return $bytes.Length
}

# Monta a lista: arquivos da raiz + tudo dentro de img/
$fila = @()
foreach ($f in @('index.html','termos.html','favicon.svg','logo-aquiete.svg','.htaccess')) {
  $p = Join-Path $base $f
  if (Test-Path $p) { $fila += [pscustomobject]@{ Local = $p; Remoto = "$root/$f" } }
}
foreach ($f in (Get-ChildItem (Join-Path $base 'img') -File)) {
  $fila += [pscustomobject]@{ Local = $f.FullName; Remoto = "$root/img/$($f.Name)" }
}

Write-Host ""
Write-Host "  Enviando $($fila.Count) arquivos..." -ForegroundColor Cyan
Write-Host ""

New-FtpDir "$root/img"

$total = 0
$erros = 0
foreach ($item in $fila) {
  $nome = Split-Path $item.Local -Leaf
  try {
    $n = Send-FtpFile $item.Local $item.Remoto
    $total += $n
    Write-Host ("    OK   {0,-24} {1,7:N1} KB" -f $nome, ($n/1KB)) -ForegroundColor Green
  } catch {
    $erros++
    Write-Host ("    ERRO {0,-24} {1}" -f $nome, $_.Exception.Message) -ForegroundColor Red
  }
}

Write-Host ""
if ($erros -eq 0) {
  Write-Host ("  Pronto. {0:N1} KB enviados." -f ($total/1KB)) -ForegroundColor Green
  Write-Host "  Abra: https://aquieteagora.com.br" -ForegroundColor Magenta
} else {
  Write-Host "  $erros arquivo(s) falharam. Confira host, usuario e senha." -ForegroundColor Yellow
}
Write-Host ""
Read-Host "  Enter para fechar"
