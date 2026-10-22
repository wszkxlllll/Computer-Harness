param([Parameter(Mandatory)][ValidateSet('Launch','Foreground','Close')][string]$Operation,[Parameter(Mandatory)][string]$RecordFile)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;
public static class CrossFourWindow {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd,uint command);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr wParam,IntPtr lParam);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent,IntPtr child);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd,StringBuilder value,int max);
 [DllImport("user32.dll",EntryPoint="GetWindowLongW")] private static extern int GetWindowLong(IntPtr hwnd,int index);
 private delegate bool EnumChildCallback(IntPtr hwnd,IntPtr parameter);
 [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hwnd,EnumChildCallback callback,IntPtr parameter);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,IntPtr wParam,IntPtr lParam,uint flags,uint timeout,out UIntPtr result);
 public sealed class BlankEditEvidence {
  public int candidateControls,readableControls,nonEmptyControls,timedOutControls;
  public bool complete=true;
  public readonly List<long> controlWindowIds=new List<long>();
 }
 public static BlankEditEvidence ReadBlankEdits(IntPtr root,uint expectedPid){
  var evidence=new BlankEditEvidence();
  var name=new StringBuilder(64);
  EnumChildWindows(root,(child,unused)=>{
   uint pid;GetWindowThreadProcessId(child,out pid);
   if(pid!=expectedPid||!IsChild(root,child)||!IsWindowVisible(child))return true;
   if(GetClassName(child,name,name.Capacity)==0||!String.Equals(name.ToString(),"Edit",StringComparison.Ordinal))return true;
   if((GetWindowLong(child,-16)&4)==0)return true; // ES_MULTILINE: document editor, not a filename/search field.
   if(++evidence.candidateControls>8){evidence.complete=false;return false;}
   UIntPtr length;
   // Read-only WM_GETTEXTLENGTH, bounded even if the new editor is not responsive.
   if(SendMessageTimeout(child,0x000E,IntPtr.Zero,IntPtr.Zero,2,250,out length)==IntPtr.Zero){evidence.timedOutControls++;return true;}
   evidence.readableControls++;evidence.controlWindowIds.Add(child.ToInt64());
   if(length.ToUInt64()!=0)evidence.nonEmptyControls++;
   return true;
  },IntPtr.Zero);
  return evidence;
 }
}
'@
function Assert-Owned($record){
 $process=Get-Process -Id ([int]$record.pid) -ErrorAction Stop
 if($process.ProcessName -notmatch '^notepad$' -or [string]$process.StartTime.ToUniversalTime().Ticks -ne $record.processStartTicks){throw 'Owned Notepad process identity changed'}
 $h=[IntPtr]::new([long]$record.windowId);[uint32]$owner=0
 if(-not [CrossFourWindow]::IsWindow($h)){throw 'Owned Notepad HWND unavailable'}
 [void][CrossFourWindow]::GetWindowThreadProcessId($h,[ref]$owner)
 if($owner -ne $record.pid){throw 'Owned Notepad PID/HWND mismatch'}
 return $process
}
if($Operation -eq 'Launch'){
 if(Test-Path -LiteralPath $RecordFile){throw 'Ownership record already exists'}
 $before=@(Get-Process -Name notepad -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
 $launched=Start-Process -FilePath (Join-Path $env:WINDIR 'System32\notepad.exe') -WindowStyle Normal -PassThru
 $deadline=[DateTime]::UtcNow.AddSeconds(20);$selected=$null
 do {
  $matches=@(Get-Process -Name notepad -ErrorAction SilentlyContinue | Where-Object {$_.Id -notin $before -and $_.MainWindowHandle -ne 0})
  if($matches.Count -eq 1){$selected=$matches[0];break}
  Start-Sleep -Milliseconds 200
 } while([DateTime]::UtcNow -lt $deadline)
 if($null -eq $selected){throw 'A unique fresh Notepad process/window was not created; no existing editor is authorized'}
 $record=@{pid=$selected.Id;windowId=$selected.MainWindowHandle.ToInt64();appName=$selected.ProcessName;processStartTicks=[string]$selected.StartTime.ToUniversalTime().Ticks;launcherPid=$launched.Id;ownedBy='cross-four-host';blankVerified=$false}
 # Persist the identity before read-only blank attestation so parent can clean this exact process after failure.
 [IO.File]::WriteAllText($RecordFile,($record|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
 [void](Assert-Owned $record)
 $h=[IntPtr]::new([long]$record.windowId)
 # One initial show/activate operation, only after exact process-start/PID/HWND attestation.
 [void][CrossFourWindow]::ShowWindow($h,9)
 $record.activationAttempted=$true;$record.activationAccepted=[CrossFourWindow]::SetForegroundWindow($h)
 [void](Assert-Owned $record)
 $record.windowVisible=[CrossFourWindow]::IsWindowVisible($h)
 $record.foregroundConfirmed=[CrossFourWindow]::GetForegroundWindow().ToInt64() -eq $record.windowId
 if(-not $record.windowVisible){[IO.File]::WriteAllText($RecordFile,($record|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false));throw 'Owned Notepad was not visible after its one explicit show operation'}
 $conditions=[Windows.Automation.OrCondition]::new([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Document))
 $readyDeadline=[DateTime]::UtcNow.AddSeconds(10);$attempts=0;$readable=0;$uiaErrors=[Collections.Generic.List[object]]::new();$native=$null
 do {
  $attempts++;[void](Assert-Owned $record);$readable=0;$nonEmpty=$false
  try {
   $root=[Windows.Automation.AutomationElement]::FromHandle($h)
   $elements=$root.FindAll([Windows.Automation.TreeScope]::Descendants,$conditions)
   foreach($element in $elements){
    if($element.Current.IsOffscreen){continue}
    [object]$pattern=$null;$text=$null
    if($element.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$pattern)){$text=([Windows.Automation.TextPattern]$pattern).DocumentRange.GetText(-1)}
    elseif($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$text=([Windows.Automation.ValuePattern]$pattern).Current.Value}
    if($null -ne $text){$readable++;if(-not [string]::IsNullOrWhiteSpace($text)){$nonEmpty=$true}}
   }
  }catch{
   # Transient UIA initialization errors are recorded, not treated as blank.
   $readable=0
   if($uiaErrors.Count -lt 8){$uiaErrors.Add(@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message})}
  }
  $native=[CrossFourWindow]::ReadBlankEdits($h,[uint32]$record.pid)
  $record.blankAttestationAttempts=$attempts;$record.blankReadOnlyControls=$readable;$record.uiaProbeErrors=@($uiaErrors.ToArray());$record.nativeBlankEvidence=$native
  if($nonEmpty -or $native.nonEmptyControls -gt 0){[IO.File]::WriteAllText($RecordFile,($record|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false));throw 'Fresh Notepad was not blank; no model Run started'}
  if($readable -gt 0 -or ($native.complete -and $native.readableControls -gt 0 -and $native.timedOutControls -eq 0)){break}
  Start-Sleep -Milliseconds 250
 }while([DateTime]::UtcNow -lt $readyDeadline)
 [void](Assert-Owned $record)
 if($readable -eq 0 -and (-not $native.complete -or $native.readableControls -eq 0 -or $native.timedOutControls -gt 0)){[IO.File]::WriteAllText($RecordFile,($record|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false));throw 'Fresh Notepad blank state could not be attested by UIA or exact multiline Edit WM_GETTEXTLENGTH within 10 seconds'}
 $record.blankVerified=$true
 $record.blankEvidenceSource=if($readable -gt 0){'UIA read-only text/value pattern'}else{'Win32 exact owned visible multiline Edit WM_GETTEXTLENGTH'}
 [IO.File]::WriteAllText($RecordFile,($record|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
 $record|ConvertTo-Json -Depth 6 -Compress
 exit
}
$record=Get-Content -Raw -LiteralPath $RecordFile|ConvertFrom-Json
if($Operation -eq 'Foreground'){
 [void](Assert-Owned $record)
 $foreground=[CrossFourWindow]::GetForegroundWindow();$cursor=$foreground;$owned=$false;$depth=0
 while($cursor -ne [IntPtr]::Zero -and $depth -lt 8){
  [uint32]$owner=0;[void][CrossFourWindow]::GetWindowThreadProcessId($cursor,[ref]$owner)
  if($owner -eq $record.pid -and $cursor.ToInt64() -eq $record.windowId){$owned=$true;break}
  $cursor=[CrossFourWindow]::GetWindow($cursor,4);$depth++
 }
 @{ownedEditorForeground=$owned;foregroundWindowId=$foreground.ToInt64();ownerDepth=$depth}|ConvertTo-Json -Compress
 exit
}
$process=Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
if($null -eq $process){@{closed=$true;alreadyExited=$true}|ConvertTo-Json -Compress;exit}
if($process.ProcessName -ne 'notepad' -or [string]$process.StartTime.ToUniversalTime().Ticks -ne $record.processStartTicks){throw 'Refusing cleanup of changed process identity'}
if([CrossFourWindow]::IsWindow([IntPtr]::new([long]$record.windowId))){[void](Assert-Owned $record);[void][CrossFourWindow]::PostMessage([IntPtr]::new([long]$record.windowId),0x0010,[IntPtr]::Zero,[IntPtr]::Zero)}
$forced=$false
if(-not $process.WaitForExit(3000)){Stop-Process -Id $process.Id -Force;$process.WaitForExit();$forced=$true}
@{closed=$true;pid=$record.pid;windowId=$record.windowId;forcedOwnedProcessOnly=$forced;neverSavedByHost=$true}|ConvertTo-Json -Compress
