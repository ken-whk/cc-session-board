# ASCII-only. Sends WM_CLOSE to the board window so FormClosing runs and the UI
# state gets saved. Stop-Process would skip that path entirely.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BoardClose {
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    public static int CloseFormsOf(uint target) {
        int n = 0;
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == target && IsWindowVisible(h)) {
                StringBuilder c = new StringBuilder(256); GetClassNameW(h, c, 256);
                // 按标题匹配，不按窗口类：WPF 版的类名不是 WindowsForms*，
                // 原来的判据只对旧 WinForms 版有效，改 WPF 后这个工具就失灵了。
                StringBuilder tt = new StringBuilder(512); GetWindowTextW(h, tt, 512);
                if (tt.ToString().Contains("Claude")) { SendMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); n++; }
            }
            return true;
        }, IntPtr.Zero);
        return n;
    }
}
"@

$proc = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*board-wpf*' -and $_.CommandLine -notlike '*-Command*' } |
    Select-Object -First 1
if (-not $proc) { Write-Output 'no board running'; exit 0 }
$n = [BoardClose]::CloseFormsOf([uint32]$proc.ProcessId)
Write-Output ('WM_CLOSE sent to ' + $n + ' window(s) of pid ' + $proc.ProcessId)
