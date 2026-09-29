param(
    [ValidateSet('prepare', 'enable', 'disable', 'remove', 'boot', 'shutdown', 'inspect')]
    [string]$Action = 'boot',
    [string]$Distribution,
    [string]$Node,
    [string]$Entry
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$modules = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
foreach ($name in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'ScheduledTasks', 'CimCmdlets')) {
    $module = Join-Path $modules $name
    Import-Module -Name $module -ErrorAction Stop
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$owner = $identity.User.Value
$root = Join-Path $env:ProgramData 'Orbit'
$record = Join-Path $root 'startup.json'
$script = Join-Path $root 'startup.ps1'
$log = Join-Path $root 'boot.jsonl'
if ($Action -eq 'shutdown') {
    $log = Join-Path $root 'shutdown.jsonl'
}
$task = 'Orbit Ubuntu'
$program = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$encoding = [Text.UTF8Encoding]::new($false)

function read {
    if (-not (Test-Path -LiteralPath $record)) {
        throw 'Orbit ownership record missing'
    }
    $value = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    if ($value.version -ne 1) { throw 'Orbit ownership version invalid' }
    if ($value.owner -ne $owner) { throw 'Orbit Windows owner changed' }
    if ($value.task -ne $task) { throw 'Orbit task identity changed' }
    return $value
}

function persist($value) {
    $text = $value | ConvertTo-Json -Depth 8
    $temporary = Join-Path $root 'startup.tmp'
    [IO.File]::WriteAllText($temporary, $text, $encoding)
    Move-Item -LiteralPath $temporary -Destination $record -Force
}

function digest($text) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $encoding.GetBytes($text)
        $hash = $algorithm.ComputeHash($bytes)
        $value = [BitConverter]::ToString($hash).Replace('-', '')
        return $value
    } finally { $algorithm.Dispose() }
}

function definition {
    $text = Export-ScheduledTask -TaskName $task -TaskPath '\'
    $value = digest $text
    return $value
}

function authorize($value) {
    $installed = Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction SilentlyContinue
    if ($installed) {
        $hash = definition
        if ($hash -ne $value.hash) { throw 'Orbit task definition changed' }
    }
    return $installed
}

function event($state, $message) {
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1048576) {
        $previous = [IO.Path]::ChangeExtension($log, 'previous.jsonl')
        Move-Item -LiteralPath $log -Destination $previous -Force
    }
    $computer = Get-CimInstance Win32_ComputerSystem
    $system = Get-CimInstance Win32_OperatingSystem
    $value = [ordered]@{
        time = [DateTimeOffset]::UtcNow.ToString('o')
        boot = $system.LastBootUpTime.ToUniversalTime().ToString('o')
        owner = $owner
        login = $computer.UserName
        state = $state
        message = $message
    }
    $text = $value | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($log, $text + [Environment]::NewLine, $encoding)
}

function prepare {
    $registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    $items = @(Get-ChildItem -LiteralPath $registry | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath })
    $selected = @($items | Where-Object { $_.DistributionName -eq $Distribution })
    if ($selected.Count -ne 1) { throw 'Ubuntu owner registration missing' }
    if ($selected[0].Version -ne 2) { throw 'WSL2 required' }
    if (Test-Path -LiteralPath $record) {
        $value = read
        if ($value.distribution -ne $Distribution) { throw 'Ubuntu identity changed' }
        $installed = authorize $value
        if (-not $installed) { register $value }
        else {
            foreach ($file in $value.files) {
                if ((Get-FileHash -LiteralPath $file.path).Hash -ne $file.hash) { throw 'Orbit Windows file changed' }
            }
            $hash = (Get-FileHash -LiteralPath $PSCommandPath).Hash
            if ($hash -ne $value.files[0].hash) {
                Copy-Item -LiteralPath $PSCommandPath -Destination $script -Force
                $value.files[0].hash = $hash
                persist $value
            }
        }
        closing $value
        return $value
    }
    if (Test-Path -LiteralPath $root) { throw 'Orbit Windows directory already exists' }
    if (Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction SilentlyContinue) {
        throw 'Orbit task already exists without ownership'
    }
    $config = Join-Path $env:USERPROFILE '.wslconfig'
    $existed = Test-Path -LiteralPath $config
    $text = if ($existed) { [IO.File]::ReadAllText($config) } else { '' }
    $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $section = [regex]::Match($text, '(?im)^\s*\[general\][^\r\n]*(?:\r?\n|$)')
    $addition = ''
    $offset = $text.Length
    if ($section.Success) {
        $tail = $text.Substring($section.Index + $section.Length)
        $next = [regex]::Match($tail, '(?m)^\s*\[')
        $body = if ($next.Success) { $tail.Substring(0, $next.Index) } else { $tail }
        $idle = [regex]::Match($body, '(?im)^\s*instanceIdleTimeout\s*=\s*([^\r\n#;]+)')
        if ($idle.Success) {
            if ($idle.Groups[1].Value.Trim() -ne '-1') { throw 'Existing WSL idle policy differs' }
        } else {
            $offset = $section.Index + $section.Length
            $separator = if ($section.Value.EndsWith("`n")) { '' } else { $newline }
            $addition = $separator + 'instanceIdleTimeout=-1' + $newline
        }
    } else {
        $separator = if ($text.Length -eq 0 -or $text.EndsWith("`n")) { '' } else { $newline }
        $addition = $separator + '[general]' + $newline + 'instanceIdleTimeout=-1' + $newline
    }
    $bytes = if ($existed) { [IO.File]::ReadAllBytes($config) } else { @() }
    $format = 'utf8'
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) { $format = 'unicode' }
    elseif ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) { $format = 'bom' }
    $value = [pscustomobject]@{
        version = 1; owner = $owner; distribution = $Distribution; task = $task
        node = $Node; entry = $Entry; config = $config; existed = $existed
        addition = $addition; offset = $offset; format = $format
        hash = ''; files = @(); stage = 'preparing'
    }
    $null = New-Item -ItemType Directory -Path $root
    persist $value
    $acl = Get-Acl -LiteralPath $root
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($owner, 'S-1-5-18', 'S-1-5-32-544')) {
        $account = [Security.Principal.SecurityIdentifier]::new($sid)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($account, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $root -AclObject $acl
    persist $value
    if ($addition) {
        $updated = $text.Insert($offset, $addition)
        $codec = codec $format
        [IO.File]::WriteAllText($config, $updated, $codec)
    }
    register $value
    closing $value
    return $value
}

function closing($value) {
    $name = 'Orbit Shutdown'
    $installed = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
    $tracked = $value.PSObject.Properties.Name -contains 'shutdown'
    if ($installed) {
        if (-not $tracked) {
            throw 'Orbit shutdown task exists without ownership'
        }
        $text = Export-ScheduledTask -TaskName $name -TaskPath '\'
        $hash = digest $text
        if ($hash -ne $value.shutdown.hash) {
            throw 'Orbit shutdown task definition changed'
        }
        return
    }
    $entry = $value.entry -replace '/boot\.js$', '/shutdown.js'
    if ($entry -eq $value.entry) {
        throw 'Orbit shutdown entry invalid'
    }
    $receipt = [pscustomobject]@{ task = $name; entry = $entry; hash = '' }
    if ($tracked) {
        $value.shutdown = $receipt
    } else {
        $value | Add-Member -NotePropertyName shutdown -NotePropertyValue $receipt
    }
    persist $value
    $argument = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '" -Action shutdown'
    $action = New-ScheduledTaskAction -Execute $program -Argument $argument -WorkingDirectory $root
    $query = "<QueryList><Query Id='0' Path='System'><Select Path='System'>*[System[Provider[@Name='User32'] and EventID=1074]]</Select></Query></QueryList>"
    $properties = @{ Enabled = $true; Subscription = $query }
    $trigger = New-CimInstance -ClientOnly -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskEventTrigger -Property $properties
    $trigger.PSObject.TypeNames.Add('Microsoft.Management.Infrastructure.CimInstance#MSFT_TaskTrigger')
    $account = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 90)
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $account -Settings $settings
    $null = Register-ScheduledTask -TaskName $name -TaskPath '\' -InputObject $definition
    $text = Export-ScheduledTask -TaskName $name -TaskPath '\'
    $value.shutdown.hash = digest $text
    persist $value
}

function register($value) {
    if (Test-Path -LiteralPath $script) {
        foreach ($file in $value.files) {
            if ((Get-FileHash -LiteralPath $file.path).Hash -ne $file.hash) { throw 'Orbit Windows file changed' }
        }
    }
    Copy-Item -LiteralPath $PSCommandPath -Destination $script -Force
    $value.files = @([pscustomobject]@{ path = $script; hash = (Get-FileHash -LiteralPath $script).Hash })
    persist $value
    $argument = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '" -Action boot'
    $action = New-ScheduledTaskAction -Execute $program -Argument $argument -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT30S'
    $account = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $account -Settings $settings
    $definition.Settings.Enabled = $false
    $null = Register-ScheduledTask -TaskName $task -TaskPath '\' -InputObject $definition
    $value.hash = definition
    $value.stage = 'prepared'
    persist $value
}

function codec($format) {
    if ($format -eq 'unicode') { return [Text.UnicodeEncoding]::new($false, $true) }
    if ($format -eq 'bom') { return [Text.UTF8Encoding]::new($true) }
    return [Text.UTF8Encoding]::new($false)
}

function remove($value) {
    $installed = authorize $value
    if ($installed -and $installed.State -eq 'Running') { throw 'Orbit boot task is running' }
    $closing = $null
    if ($value.PSObject.Properties.Name -contains 'shutdown') {
        $closing = Get-ScheduledTask -TaskName $value.shutdown.task -TaskPath '\' -ErrorAction SilentlyContinue
        if ($closing) {
            $text = Export-ScheduledTask -TaskName $value.shutdown.task -TaskPath '\'
            $hash = digest $text
            if ($hash -ne $value.shutdown.hash) {
                throw 'Orbit shutdown task definition changed'
            }
            if ($closing.State -eq 'Running') {
                throw 'Orbit shutdown task is running'
            }
        }
    }
    foreach ($file in $value.files) {
        if (Test-Path -LiteralPath $file.path) {
            if ((Get-FileHash -LiteralPath $file.path).Hash -ne $file.hash) { throw 'Orbit Windows file changed' }
        }
    }
    if ($value.addition) {
        $text = [IO.File]::ReadAllText($value.config)
        $offset = $text.IndexOf($value.addition, [StringComparison]::Ordinal)
        if ($offset -lt 0) { throw 'Orbit WSL addition changed; preserved' }
        $next = $text.IndexOf($value.addition, $offset + $value.addition.Length, [StringComparison]::Ordinal)
        if ($next -ge 0) { throw 'Orbit WSL addition ambiguous; preserved' }
        $updated = $text.Remove($offset, $value.addition.Length)
        $codec = codec $value.format
        if (-not $value.existed -and $updated.Length -eq 0) { Remove-Item -LiteralPath $value.config }
        else { [IO.File]::WriteAllText($value.config, $updated, $codec) }
    }
    if ($installed) { Unregister-ScheduledTask -TaskName $task -TaskPath '\' -Confirm:$false }
    if ($closing) {
        Unregister-ScheduledTask -TaskName $value.shutdown.task -TaskPath '\' -Confirm:$false
    }
    foreach ($file in $value.files) { if (Test-Path -LiteralPath $file.path) { Remove-Item -LiteralPath $file.path } }
    foreach ($name in @('boot.jsonl', 'boot.previous.jsonl', 'shutdown.jsonl', 'shutdown.previous.jsonl', 'startup.tmp')) {
        $filename = Join-Path $root $name
        if (Test-Path -LiteralPath $filename) { Remove-Item -LiteralPath $filename }
    }
    $remaining = @(Get-ChildItem -LiteralPath $root | Where-Object { $_.Name -ne 'startup.json' })
    if ($remaining.Count) { throw 'Orbit Windows residual files preserved' }
    Remove-Item -LiteralPath $record
    Remove-Item -LiteralPath $root
}

function shutdown($value) {
    $mutex = [Threading.Mutex]::new($false, 'Global\Orbit-Ubuntu-' + $owner)
    $held = $false
    try {
        try {
            $held = $mutex.WaitOne(5000)
        } catch [Threading.AbandonedMutexException] {
            $held = $true
        }
        if (-not $held) {
            throw 'Orbit boot operation still running'
        }
        $listing = @(& $wsl --list --running --quiet 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw 'Ubuntu running state unavailable'
        }
        $names = $listing | ForEach-Object { $_.ToString().Replace([string][char]0, '').Trim() }
        if ($value.distribution -notin $names) {
            event 'skipped' 'Ubuntu already stopped'
            return
        }
        event 'stopping' 'Orbit local service shutdown'
        $args = @('--distribution', $value.distribution, '--user', 'root', '--exec', '/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', '65s', '/usr/bin/env', 'ORBIT_SYSTEM=1', $value.node, $value.shutdown.entry)
        $quoted = $args | ForEach-Object {
            if ($_ -match '\s') {
                '"' + $_ + '"'
            } else {
                $_
            }
        }
        $arguments = $quoted -join ' '
        $setting = [Diagnostics.ProcessStartInfo]::new()
        $setting.FileName = $wsl
        $setting.Arguments = $arguments
        $setting.UseShellExecute = $false
        $setting.CreateNoWindow = $true
        $setting.RedirectStandardOutput = $true
        $setting.RedirectStandardError = $true
        $child = [Diagnostics.Process]::new()
        $child.StartInfo = $setting
        try {
            $null = $child.Start()
            $output = $child.StandardOutput.ReadToEndAsync()
            $diagnostic = $child.StandardError.ReadToEndAsync()
            if (-not $child.WaitForExit(70000)) {
                $child.Kill()
                $child.WaitForExit()
                throw 'Orbit shutdown timed out'
            }
            if ($child.ExitCode -ne 0) {
                throw $diagnostic.Result
            }
            $state = $output.Result | ConvertFrom-Json
            event $state.state ($output.Result.Trim())
        } finally {
            $child.Dispose()
        }
    } catch {
        event 'failed' $_.Exception.Message
        throw
    } finally {
        if ($held) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

function boot($value) {
    $mutex = [Threading.Mutex]::new($false, 'Global\Orbit-Ubuntu-' + $owner)
    $held = $false
    try {
        try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { return }
        event 'starting' 'Ubuntu readiness'
        $args = @('--distribution', $value.distribution, '--user', 'root', '--exec', '/usr/bin/env', 'ORBIT_SYSTEM=1', $value.node, $value.entry)
        $output = @(& $wsl @args 2>&1)
        if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
        $state = ($output -join [Environment]::NewLine) | ConvertFrom-Json
        if ($state.state -eq 'disabled') { event 'disabled' 'Startup OFF'; return }
        $ready = $false
        for ($attempt = 0; $attempt -lt 12; $attempt++) {
            try {
                $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/health/ingress' -UseBasicParsing -TimeoutSec 2
                $body = $response.Content | ConvertFrom-Json
                if ($response.StatusCode -eq 200 -and $body.project -eq 'Orbit' -and $body.role -eq 'ingress') { $ready = $true; break }
            } catch { }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw 'Windows localhost:8080 unavailable' }
        event 'ready' 'Orbit health and Windows ingress ready'
    } catch {
        event 'failed' $_.Exception.Message
        throw
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

try {
    $admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $reading = $Action -eq 'inspect'
    $booting = $Action -eq 'boot'
    $stopping = $Action -eq 'shutdown'
    if (-not $admin -and (Test-Path -LiteralPath $record)) {
        $value = read
        $installed = authorize $value
        $unchanged = $false
        if ($Action -eq 'prepare' -and $value.stage -eq 'prepared' -and $installed) {
            $source = (Get-FileHash -LiteralPath $PSCommandPath).Hash
            $tracked = $value.PSObject.Properties.Name -contains 'shutdown'
            $matching = $value.files[0].hash -eq $source
            $complete = $false
            if ($tracked) {
                $closing = Get-ScheduledTask -TaskName $value.shutdown.task -TaskPath '\' -ErrorAction SilentlyContinue
                if ($closing) {
                    $text = Export-ScheduledTask -TaskName $value.shutdown.task -TaskPath '\'
                    $hash = digest $text
                    $complete = $hash -eq $value.shutdown.hash
                }
            }
            $unchanged = $matching -and $complete
        } elseif ($Action -eq 'enable' -and $installed) {
            $unchanged = $installed.Settings.Enabled
        } elseif ($Action -eq 'disable' -and $installed) {
            $unchanged = -not $installed.Settings.Enabled
        }
        if ($unchanged) { $value | ConvertTo-Json -Depth 8 -Compress; exit 0 }
    }
    if (-not $reading -and -not $booting -and -not $stopping -and -not $admin) {
        $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Action', $Action)
        if ($Distribution) { $args += @('-Distribution', ('"' + $Distribution + '"')) }
        if ($Node) { $args += @('-Node', ('"' + $Node + '"')) }
        if ($Entry) { $args += @('-Entry', ('"' + $Entry + '"')) }
        $child = Start-Process -FilePath $program -ArgumentList $args -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        if ($child.ExitCode -ne 0) { throw 'Windows Startup authorization or operation failed' }
        if ($Action -eq 'remove') { '{"removed":true}' }
        else { read | ConvertTo-Json -Depth 8 -Compress }
        exit 0
    }
    if ($Action -eq 'prepare') { $value = prepare }
    else {
        $value = read
        if ($Action -eq 'inspect') { $value | ConvertTo-Json -Depth 8 -Compress; exit 0 }
        if ($Action -eq 'boot') { boot $value; exit 0 }
        if ($Action -eq 'shutdown') {
            shutdown $value
            exit 0
        }
        if ($Action -eq 'remove') { remove $value; '{"removed":true}'; exit 0 }
        $null = authorize $value
        if ($Action -eq 'enable') { $null = Enable-ScheduledTask -TaskName $task -TaskPath '\' }
        else { $null = Disable-ScheduledTask -TaskName $task -TaskPath '\' }
        $value.hash = definition
        persist $value
    }
    $value | ConvertTo-Json -Depth 8 -Compress
} catch {
    if (Test-Path -LiteralPath $root) {
        try { event 'failed' $_.Exception.Message } catch { }
    }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
