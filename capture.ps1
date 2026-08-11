# ASCII-only. Captures the board window to board-capture.png.
#
# Framework-agnostic on purpose: matches by window TITLE plus a minimum size,
# not by window class or owning process. Earlier versions keyed on the WinForms
# class, then the WPF class, and broke each time the UI framework changed; they
# also grabbed a 160x28 minimized placeholder once. Title + size survives all of
# that (WPF uses HwndWrapper*, Electron uses Chrome_WidgetWin_1).
#
# Optional arg: -Title <substring>   (default: Claude)

param([string]$Title = 'Claude')

Add-Type -AssemblyName System.Drawing

$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class BoardCap {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);

    public static IntPtr Find(string needle) {
        IntPtr hit = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            // Skip minimized windows: their rect is a 160x28 placeholder at -32000
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            StringBuilder t = new StringBuilder(512); GetWindowTextW(h, t, 512);
            if (!t.ToString().Contains(needle)) return true;
            RECT r; GetWindowRect(h, out r);
            if ((r.R - r.L) < 300 || (r.B - r.T) < 200) return true;
            hit = h;
            return false;
        }, IntPtr.Zero);
        return hit;
    }
}
"@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing

$h = [BoardCap]::Find($Title)
if ($h -eq [IntPtr]::Zero) { Write-Output 'FAIL: no matching window (running? minimized?)'; exit 1 }

$r = New-Object BoardCap+RECT
[void][BoardCap]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$ht = $r.B - $r.T
Write-Output ('window size = ' + $w + ' x ' + $ht)

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# flags=2 (PW_RENDERFULLCONTENT) is required for Chromium-based windows;
# without it an Electron window captures as a blank rectangle.
[void][BoardCap]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()

$out = Join-Path $PSScriptRoot 'board-capture.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ('saved = ' + $out)
