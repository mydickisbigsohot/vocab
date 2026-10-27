param([ValidateSet('Start','Stop','Status','InstallStartup','RemoveStartup')][string]$Action='Status')
$ErrorActionPreference='Stop'
$vocabRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vocabScript=Join-Path $PSScriptRoot 'watch_folder.py'
$vocabLocal=Join-Path $vocabRoot '.local'
$vocabState=Join-Path $vocabLocal 'watcher-process.json'
$vocabStartup=Join-Path ([Environment]::GetFolderPath('Startup')) '词间截图同步.lnk'
function Find-Watcher {
  if(Test-Path -LiteralPath $vocabState){
    $vocabSaved=Get-Content -LiteralPath $vocabState -Raw | ConvertFrom-Json
    $vocabProcess=Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$vocabSaved.pid)" -ErrorAction SilentlyContinue
    if($vocabProcess -and $vocabProcess.CommandLine -and $vocabProcess.CommandLine.Contains($vocabScript) -and $vocabProcess.Name -in @('python.exe','pythonw.exe')){return $vocabProcess}
  }
  $vocabCandidates=@(Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($vocabScript) -and $_.CommandLine.Contains('--watch')})
  if($vocabCandidates.Count -eq 1){return $vocabCandidates[0]}
  return $null
}
function Python-Path {
  $vocabPython=$null
  $vocabConfigPath=Join-Path $vocabLocal 'config.json'
  if(Test-Path -LiteralPath $vocabConfigPath){
    $vocabConfig=Get-Content -LiteralPath $vocabConfigPath -Raw | ConvertFrom-Json
    if($vocabConfig.pythonExecutable -and [IO.Path]::IsPathRooted($vocabConfig.pythonExecutable) -and (Test-Path -LiteralPath $vocabConfig.pythonExecutable)){$vocabPython=$vocabConfig.pythonExecutable}
  }
  if(!$vocabPython){$vocabPython=(Get-Command python -ErrorAction SilentlyContinue).Source}
  if(!$vocabPython -or $vocabPython.Contains('WindowsApps')){
    $vocabPython=(Get-Command py -ErrorAction SilentlyContinue).Source
    if($vocabPython){$vocabPython=(& $vocabPython -c 'import sys; print(sys.executable)').Trim()}
  }
  if(!$vocabPython -or !(Test-Path -LiteralPath $vocabPython)){throw '找不到可用 Python，请安装 Python 后重试。'}
  $vocabWindowless=Join-Path (Split-Path $vocabPython) 'pythonw.exe'
  if(Test-Path -LiteralPath $vocabWindowless){return $vocabWindowless}
  return $vocabPython
}
switch($Action){
  'Start' {
    if(Find-Watcher){Write-Output '截图同步已在运行。';break}
    New-Item -ItemType Directory -Path $vocabLocal -Force | Out-Null
    $vocabLaunched=Start-Process -FilePath (Python-Path) -ArgumentList @(('"'+$vocabScript+'"'),'--watch') -WorkingDirectory $vocabRoot -WindowStyle Hidden -PassThru
    @{pid=$vocabLaunched.Id;script=$vocabScript;startedAt=[DateTimeOffset]::Now.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $vocabState -Encoding utf8
    Write-Output '已启动私密截图同步。'
  }
  'Stop' {
    $vocabRunning=Find-Watcher
    if($vocabRunning){Stop-Process -Id $vocabRunning.ProcessId;Write-Output '已停止截图同步。'}else{Write-Output '没有本项目的同步进程。'}
  }
  'Status' {
    $vocabRunning=Find-Watcher
    Write-Output $(if($vocabRunning){'截图同步正在运行。'}else{'本项目启动器未记录运行进程。'})
    $vocabStatus=Join-Path $vocabLocal 'watcher-status.json'
    if(Test-Path -LiteralPath $vocabStatus){Get-Content -LiteralPath $vocabStatus -Raw}
  }
  'InstallStartup' {
    $vocabShell=New-Object -ComObject WScript.Shell
    if(Test-Path -LiteralPath $vocabStartup){
      $vocabExisting=$vocabShell.CreateShortcut($vocabStartup)
      if(!$vocabExisting.Arguments.Contains($vocabScript)){throw '同名启动项属于其他位置，已停止，未覆盖。'}
    }
    $vocabLink=$vocabShell.CreateShortcut($vocabStartup)
    $vocabLink.TargetPath=Python-Path
    $vocabLink.Arguments='"'+$vocabScript+'" --watch'
    $vocabLink.WorkingDirectory=$vocabRoot
    $vocabLink.WindowStyle=7
    $vocabLink.Description='仅将指定截图文件夹的新图同步到自己的私有词库'
    $vocabLink.Save()
    Write-Output '已添加当前用户登录时启动的截图同步。'
  }
  'RemoveStartup' {
    if(Test-Path -LiteralPath $vocabStartup){
      $vocabShell=New-Object -ComObject WScript.Shell
      if(!$vocabShell.CreateShortcut($vocabStartup).Arguments.Contains($vocabScript)){throw '启动项不属于此项目，未删除。'}
      Remove-Item -LiteralPath $vocabStartup
    }
    Write-Output '已移除此项目的登录启动项。'
  }
}
