param(
    [Parameter(Mandatory=$true)][string]$Server,
    [Parameter(Mandatory=$true)][string]$IdentityFile,
    [ValidateSet('status','events','outbox','panic','resume','send')][string]$Command='status',
    [string]$Chat='experiment',
    [string]$Sender='Owner',
    [string]$Text
)
$ErrorActionPreference='Stop'
function ConvertTo-ShellLiteral([string]$Value) {
    $taskQuote = [string][char]39
    $taskEscapedQuote = -join ([char]39,[char]34,[char]39,[char]34,[char]39)
    return $taskQuote + $Value.Replace($taskQuote, $taskEscapedQuote) + $taskQuote
}
$taskArgs = @($Command)
if ($Command -eq 'send') { if (-not $Text) { throw 'Text is required for send' }; $taskArgs += @($Chat,$Sender,$Text) }
$taskRemote = 'cd /opt/ai && sh scripts/ctl.sh ' + (($taskArgs | ForEach-Object { ConvertTo-ShellLiteral $_ }) -join ' ')
& ssh -o BatchMode=yes -o ConnectTimeout=15 -i $IdentityFile "root@$Server" $taskRemote
if ($LASTEXITCODE -ne 0) { throw "Remote command failed: $LASTEXITCODE" }
