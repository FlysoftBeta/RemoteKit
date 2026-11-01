# Read-only HWND inventory. Run in the same Windows session/desktop as the target.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ProcessId,
  [string]$ExpectedExecutablePath
)
$ErrorActionPreference = 'Stop'
$targetProcess = Get-Process -Id $ProcessId -ErrorAction Stop
$targetPath = $targetProcess.Path
if ([string]::IsNullOrWhiteSpace($targetPath)) { throw "Cannot verify executable path for process $ProcessId" }
$targetPath = (Get-Item -LiteralPath $targetPath -ErrorAction Stop).FullName
$targetStart = $targetProcess.StartTime.ToUniversalTime()
if ($ExpectedExecutablePath) {
  $expectedItem = Get-Item -LiteralPath $ExpectedExecutablePath -ErrorAction Stop
  if ($expectedItem.PSIsContainer -or ![string]::Equals($targetPath,$expectedItem.FullName,[StringComparison]::OrdinalIgnoreCase)) {
    throw "Executable mismatch for process ${ProcessId}: expected '$ExpectedExecutablePath', found '$targetPath'"
  }
}
if (!('RemoteKit.ProcessWindowInspectionV1' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace RemoteKit {
  public sealed class ProcessWindowInspectionV1 {
    delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    public sealed class Window {
      public string hwnd, windowClass, parent, owner, kind;
      public uint threadId;
      public bool visible, boundsAvailable;
      public Rect bounds;
      public List<string> enumerationSources = new List<string>();
    }
    [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll", SetLastError=true)] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string className, string title);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong32(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLong64(IntPtr window, int index);
    static string Handle(IntPtr value) { return "0x" + unchecked((ulong)value.ToInt64()).ToString("x"); }
    public static Window[] Inspect(uint processId) {
      var found = new Dictionary<IntPtr, Window>();
      Action<IntPtr,string,bool> add = (window, source, messageOnly) => {
        uint ownerPid; uint thread = GetWindowThreadProcessId(window, out ownerPid);
        if (ownerPid != processId) return;
        Window value;
        if (!found.TryGetValue(window, out value)) {
          var name = new StringBuilder(512); GetClassNameW(window,name,name.Capacity);
          long style = IntPtr.Size == 8 ? GetWindowLong64(window,-16).ToInt64() : GetWindowLong32(window,-16);
          Rect bounds; bool hasBounds = GetWindowRect(window,out bounds);
          value = new Window { hwnd=Handle(window), windowClass=name.ToString(), threadId=thread,
            parent=Handle(messageOnly ? GetParent(window) : GetAncestor(window,1)), owner=Handle(GetWindow(window,4)),
            kind=messageOnly ? "message-only" : ((style & 0x40000000L)!=0 ? "child" : "top-level"),
            visible=IsWindowVisible(window), boundsAvailable=hasBounds, bounds=bounds };
          found.Add(window,value);
        }
        if (!value.enumerationSources.Contains(source)) value.enumerationSources.Add(source);
      };
      EnumProc normal = (window, unused) => { add(window,"EnumWindows",false); return true; };
      // EnumWindows covers this desktop, not message-only windows. Enumerate
      // descendants even for foreign parents, since a child can belong to PID.
      EnumProc top = (window, unused) => {
        normal(window,unused);
        EnumChildWindows(window,(child,p) => { add(child,"EnumChildWindows",false); return true; },IntPtr.Zero);
        return true;
      };
      if (!EnumWindows(top,IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      var visited = new HashSet<IntPtr>(); IntPtr current = IntPtr.Zero;
      while ((current=FindWindowExW(new IntPtr(-3),current,null,null)) != IntPtr.Zero && visited.Add(current)) {
        add(current,"FindWindowEx(HWND_MESSAGE)",true);
        EnumChildWindows(current,(child,p) => { add(child,"message-only descendant",true); return true; },IntPtr.Zero);
      }
      var output = new List<Window>(found.Values);
      output.Sort((a,b) => StringComparer.Ordinal.Compare(a.hwnd,b.hwnd));
      return output.ToArray();
    }
  }
}
'@
}
$windows = @([RemoteKit.ProcessWindowInspectionV1]::Inspect([uint32]$ProcessId))
$targetProcess.Refresh()
if ($targetProcess.HasExited) { throw "Target exited during enumeration; discard this snapshot" }
$currentProcess = Get-Process -Id $ProcessId -ErrorAction Stop
if ($currentProcess.StartTime.ToUniversalTime() -ne $targetStart -or
    ![string]::Equals($currentProcess.Path,$targetPath,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'Target identity changed during enumeration; discard this snapshot'
}
[ordered]@{
  processId=$ProcessId; executablePath=$targetPath; startedAtUtc=$targetStart.ToString('o')
  inspectedAtUtc=[DateTime]::UtcNow.ToString('o'); windowCount=$windows.Count; windows=$windows
  limits=@(
    'Current session/desktop only; inaccessible desktops and windows created/destroyed during enumeration can be missed.'
    'Message-only roots use FindWindowEx(HWND_MESSAGE); titles and application roles are not inferred.'
    'HWND kind/class does not establish whether a window displays a WebView; invisible helper windows can be normal.'
    'Bounds are GetWindowRect coordinates under the caller DPI context; message-only bounds do not represent a displayed surface.'
  )
} | ConvertTo-Json -Depth 7
