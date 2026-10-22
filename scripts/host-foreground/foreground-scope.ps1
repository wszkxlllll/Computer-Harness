param(
 [Parameter(Mandatory)][string]$EditorRecord,
 [int]$BrowserPid=0,[long]$BrowserWindowId=0,
 [string]$PointX,[string]$PointY
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$hasPoint=$PSBoundParameters.ContainsKey('PointX')
if($hasPoint -ne $PSBoundParameters.ContainsKey('PointY')){throw 'PointX and PointY must be supplied together'}
$sampleX=0;$sampleY=0
if($hasPoint){
 if($PointX -notmatch '^-?\d+$' -or $PointY -notmatch '^-?\d+$'){throw 'Probe requires explicit physical integer samples; no implicit rounding'}
 $sampleX=[int]::Parse($PointX,[Globalization.CultureInfo]::InvariantCulture)
 $sampleY=[int]::Parse($PointY,[Globalization.CultureInfo]::InvariantCulture)
}
# Read-only metadata only: no captions, control text, document, clipboard or global inventory.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class HostPointScope {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; public Point(int a,int b){x=a;y=b;} }
 [StructLayout(LayoutKind.Sequential)] struct ComboInfo { public int cbSize; public Rect item,button; public uint buttonState; public IntPtr combo,edit,list; }
 [StructLayout(LayoutKind.Sequential)] struct GuiInfo { public int cbSize; public uint flags; public IntPtr active,focus,capture,menuOwner,moveSize,caret; public Rect caretRect; }
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
 [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a,IntPtr b);
 [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint command);
 [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] static extern bool GetComboBoxInfo(IntPtr h,ref ComboInfo info);
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GuiInfo info);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder name,int size);
 [DllImport("user32.dll",EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr h,int index);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h,uint attribute,out int value,int size);
 delegate bool EnumChildCallback(IntPtr h,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,EnumChildCallback callback,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread,EnumChildCallback callback,IntPtr data);
 public sealed class Window {
  public long windowId,parentWindowId,ownerWindowId; public uint pid,threadId,dpi;
  public string processStartTicks,windowClass; public bool valid,visible,enabled,minimized,cloakedKnown,cloaked,boundsValid; public Rect bounds;
  public bool editStyleKnown,editMultiline,editReadOnly;
 }
 public sealed class Region {
  public string kind,proof; public long comboWindowId,listWindowId; public Window window,control; public Window[] parentChain,ownerChain;
 }
 public sealed class Hit { public Point point; public Window window; public Window[] parentChain,ownerChain; }
 public sealed class Sample {
  public string role="outside",reason="unproven foreground",coordinateSpace="physical-screen-pixels";
  public bool physicalCoordinates,rootIdentityValid,controlsComplete,guiInfoValid;
  public long foregroundWindowId,focusWindowId,captureWindowId,activeWindowId;
  public Window root,foreground,focusWindow,captureWindow; public Window[] ownerChain,focusParents,captureParents;
  public Region[] regions=new Region[0]; public Hit pointHit;
  public bool browserPopupCandidate,browserPopupInventoryComplete; public Window[] browserOwnedPopups=new Window[0];
 }
 static Window Read(IntPtr h){
  var w=new Window();w.windowId=h.ToInt64();w.valid=h!=IntPtr.Zero&&IsWindow(h);if(!w.valid)return w;
  uint pid;w.threadId=GetWindowThreadProcessId(h,out pid);w.pid=pid;
  try{using(var p=Process.GetProcessById((int)pid)){w.processStartTicks=p.StartTime.ToUniversalTime().Ticks.ToString();}}catch{w.processStartTicks=null;}
  w.parentWindowId=GetAncestor(h,1).ToInt64();w.ownerWindowId=GetWindow(h,4).ToInt64();
  var name=new StringBuilder(256);if(GetClassName(h,name,name.Capacity)>0)w.windowClass=name.ToString();
  if(w.windowClass=="Edit"){int style=GetWindowLong(h,-16);w.editStyleKnown=style!=0;w.editMultiline=(style&4)!=0;w.editReadOnly=(style&0x800)!=0;}
  w.visible=IsWindowVisible(h);w.enabled=IsWindowEnabled(h);w.minimized=IsIconic(h);w.dpi=GetDpiForWindow(h);
  Rect r;w.boundsValid=GetWindowRect(h,out r)&&r.right>r.left&&r.bottom>r.top;w.bounds=r;
  int cloak;w.cloakedKnown=DwmGetWindowAttribute(h,14,out cloak,4)==0;w.cloaked=w.cloakedKnown&&cloak!=0;
  return w;
 }
 static Window[] Chain(IntPtr h,bool owner){
  var result=new List<Window>();var seen=new HashSet<long>();
  for(int i=0;h!=IntPtr.Zero&&h!=GetDesktopWindow()&&i<32;i++){
   if(!seen.Add(h.ToInt64()))break;result.Add(Read(h));h=owner?GetWindow(h,4):GetAncestor(h,1);
  }
  return result.ToArray();
 }
 static bool Identity(Window w){return w!=null&&w.valid&&w.pid>0&&w.processStartTicks!=null;}
 static bool Usable(Window w){return Identity(w)&&w.visible&&w.enabled&&!w.minimized&&w.boundsValid&&w.dpi>0;}
 static bool Contains(Window[] chain,long hwnd){foreach(var w in chain)if(w.windowId==hwnd&&Identity(w))return true;return false;}
 static bool ValidChain(Window[] chain){foreach(var w in chain)if(!Identity(w))return false;return true;}
 public static Sample Capture(long editorHwnd,int editorPid,string editorTicks,int browserPid,long browserHwnd,bool hasPoint,int x,int y){
  var s=new Sample();var previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
  try{
   s.physicalCoordinates=AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),new IntPtr(-4));
   var fg=GetForegroundWindow();s.foreground=Read(fg);s.foregroundWindowId=fg.ToInt64();s.ownerChain=Chain(fg,true);
   var editor=Read(new IntPtr(editorHwnd));var browser=Read(new IntPtr(browserHwnd));
   bool editorValid=Identity(editor)&&editor.pid==editorPid&&editor.processStartTicks==editorTicks;
   bool browserValid=Identity(browser)&&browserPid>0&&browser.pid==browserPid;
   if(browserValid){
    var popups=new List<Window>();int visited=0;s.browserPopupInventoryComplete=true;
    bool completed=EnumThreadWindows(browser.threadId,(h,unused)=>{
     if(++visited>128){s.browserPopupInventoryComplete=false;return false;}
     var child=Read(h);if(child.visible&&child.ownerWindowId==browserHwnd)popups.Add(child);return true;
    },IntPtr.Zero);
    s.browserPopupInventoryComplete=s.browserPopupInventoryComplete&&completed;
    popups.Sort((a,b)=>a.windowId.CompareTo(b.windowId));s.browserOwnedPopups=popups.ToArray();
   }
   if(ValidChain(s.ownerChain)){
    if(editorValid&&Contains(s.ownerChain,editorHwnd)){s.root=editor;s.role="editor";}
    else if(browserValid&&Contains(s.ownerChain,browserHwnd)){s.root=browser;s.role="browser";}
   }
   s.rootIdentityValid=s.root!=null;
   var gui=new GuiInfo();gui.cbSize=Marshal.SizeOf(typeof(GuiInfo));
   s.guiInfoValid=s.foreground.valid&&GetGUIThreadInfo(s.foreground.threadId,ref gui);
   s.focusWindowId=gui.focus.ToInt64();s.captureWindowId=gui.capture.ToInt64();s.activeWindowId=gui.active.ToInt64();
   if(gui.focus!=IntPtr.Zero){s.focusWindow=Read(gui.focus);s.focusParents=Chain(gui.focus,false);}
   if(gui.capture!=IntPtr.Zero){s.captureWindow=Read(gui.capture);s.captureParents=Chain(gui.capture,false);}
   var regions=new List<Region>();
   // A browser-owned popup remains an unadmitted candidate. The JS Host must
   // prove completed Ctrl+F intent, a newly surfaced exact HWND and focused UIA Edit.
   s.browserPopupCandidate=s.role=="browser"&&s.foreground.windowId!=browserHwnd&&s.foreground.ownerWindowId==browserHwnd&&s.foreground.pid==browser.pid;
   if(s.browserPopupCandidate)s.role="browser-popup";
   bool foregroundKind=s.root!=null&&(s.root.windowId==s.foregroundWindowId||s.foreground.windowClass=="#32770"||s.browserPopupCandidate);
   if(s.physicalCoordinates&&foregroundKind&&Usable(s.foreground)&&Identity(s.root)&&s.root.visible&&!s.root.minimized&&s.root.boundsValid&&s.root.dpi>0&&
      s.foreground.cloakedKnown&&!s.foreground.cloaked&&s.root.cloakedKnown&&!s.root.cloaked&&s.guiInfoValid){
    s.reason="exact foreground root/dialog and localized native control proof";
    regions.Add(new Region{kind="foreground",window=s.foreground,parentChain=Chain(fg,false),ownerChain=s.ownerChain});
    // Enumerate this one foreground subtree, never all desktop windows. Class
    // names only select a query; GetComboBoxInfo exact HWND equality is proof.
    int count=0;s.controlsComplete=true;var className=new StringBuilder(256);
    EnumChildWindows(fg,(child,unused)=>{
     if(++count>4096){s.controlsComplete=false;return false;}
     if(GetClassName(child,className,className.Capacity)==0)return true;
     if(className.ToString()!="ComboBox"&&className.ToString()!="ComboBoxEx32")return true;
     var control=Read(child);if(!Usable(control))return true;
     var info=new ComboInfo();info.cbSize=Marshal.SizeOf(typeof(ComboInfo));
     if(!GetComboBoxInfo(child,ref info)||info.combo!=child||info.list==IntPtr.Zero)return true;
     var parents=Chain(child,false);if(!ValidChain(parents)||!Contains(parents,s.foregroundWindowId))return true;
     var list=Read(info.list);if(!Usable(list))return true;
     // DWM cloak is a top-level fact: a list may have no independent DWM row.
     if(list.cloakedKnown&&list.cloaked)return true;
     regions.Add(new Region{kind="combo-list",proof="GetComboBoxInfo",comboWindowId=info.combo.ToInt64(),listWindowId=info.list.ToInt64(),window=list,control=control,parentChain=parents,ownerChain=Chain(info.list,true)});
     return true;
    },IntPtr.Zero);
   }else{s.role="outside";s.reason="foreground identity, native role, DPI, visibility or GUI-thread evidence missing";}
   regions.Sort((a,b)=>{int kind=String.CompareOrdinal(a.kind,b.kind);return kind!=0?kind:a.window.windowId.CompareTo(b.window.windowId);});s.regions=regions.ToArray();
   if(hasPoint){var point=new Point(x,y);var hit=WindowFromPoint(point);s.pointHit=new Hit{point=point,window=Read(hit),parentChain=Chain(hit,false),ownerChain=Chain(hit,true)};}
   return s;
  }finally{if(previous!=IntPtr.Zero)SetThreadDpiAwarenessContext(previous);}
 }
}
'@
# An absent explicit ownership record disables the editor role.
$editor=$null;$editorPid=0
if(Test-Path -LiteralPath $EditorRecord){
 $editor=Get-Content -LiteralPath $EditorRecord -Raw|ConvertFrom-Json
 $process=Get-Process -Id ([int]$editor.pid) -ErrorAction SilentlyContinue
 $editorValid=$null -ne $process -and $process.ProcessName -eq 'notepad' -and [string]$process.StartTime.ToUniversalTime().Ticks -eq [string]$editor.processStartTicks
 if($editorValid){$editorPid=[int]$editor.pid}
}
$started=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
function Read-PopupFocus($sample){
 if(-not $sample.browserPopupCandidate){return $null}
 try{
  $focused=[Windows.Automation.AutomationElement]::FocusedElement
  $leaf=$focused.Current
  if($leaf.ControlType -ne [Windows.Automation.ControlType]::Edit -or -not $leaf.HasKeyboardFocus -or -not $leaf.IsEnabled -or $leaf.IsOffscreen){return @{confirmed=$false}}
  $cursor=$focused;$nearest=0
  for($i=0;$i -lt 16 -and $null -ne $cursor;$i++){
   $current=$cursor.Current
   if($current.NativeWindowHandle -ne 0){$nearest=$current.NativeWindowHandle;break}
   $cursor=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cursor)
  }
  return @{confirmed=($nearest -eq $sample.foregroundWindowId -and $leaf.ProcessId -eq $sample.root.pid);nativeWindowId=$nearest;processId=$leaf.ProcessId;controlType='Edit';runtimeId=@($focused.GetRuntimeId());automationId=$leaf.AutomationId}
 }catch{return @{confirmed=$false;probeUnavailable=$true}}
}
$scope=[HostPointScope]::Capture([long]$editor.windowId,$editorPid,[string]$editor.processStartTicks,$BrowserPid,$BrowserWindowId,$hasPoint,$sampleX,$sampleY)
$focusProof=Read-PopupFocus $scope
# Two localized reads bound each sample. The consumer compares semantic fields,
# not timestamps or bytes, and must also compare observation-time vs dispatch.
$recheck=[HostPointScope]::Capture([long]$editor.windowId,$editorPid,[string]$editor.processStartTicks,$BrowserPid,$BrowserWindowId,$hasPoint,$sampleX,$sampleY)
$recheckFocusProof=Read-PopupFocus $recheck
@{schema='host-point-scope/v1';capturedAt=$started;completedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();sample=$scope;recheck=$recheck;browserPopupFocus=$focusProof;browserPopupFocusRecheck=$recheckFocusProof}|ConvertTo-Json -Depth 16 -Compress
