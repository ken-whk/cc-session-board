# ASCII-only. Captures consecutive screen frames of the board window and diffs
# them pixel by pixel, so we can see WHAT area actually repaints on each refresh
# instead of arguing about it.
#
# Limitation (stated up front): sampling is ~12fps, so a very short erase-to-
# background frame may be missed. What this DOES prove is how much area changes
# per refresh - a few cells vs the whole list - which is the question at hand.

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Assign the here-string first: putting it right after a parameter list makes
# PowerShell misparse the C# "using" lines as PowerShell using statements.
$src = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class FlickerWatch {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    private delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] public struct PT { public int X, Y; }
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out PT p);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();

    public static IntPtr FindForm(uint target) {
        IntPtr hit = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == target && IsWindowVisible(h)) {
                StringBuilder c = new StringBuilder(256); GetClassNameW(h, c, 256);
                StringBuilder tt = new StringBuilder(512); GetWindowTextW(h, tt, 512);
                if (tt.ToString().Contains("Claude")) { hit = h; return false; }
            }
            return true;
        }, IntPtr.Zero);
        return hit;
    }

    public static string dir = "";
    public static int shots = 0;
    public static int tail = 0;
    public static string[] Watch(int x, int y, int w, int h, int frames, int intervalMs) {
        List<string> res = new List<string>();
        Bitmap prev = null;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        Rectangle rect = new Rectangle(0, 0, w, h);

        for (int f = 0; f < frames; f++) {
            Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp)) {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            if (prev != null) {
                long dt = sw.ElapsedMilliseconds; sw.Restart();
                var d1 = prev.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                var d2 = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                int stride = d1.Stride;
                byte[] b1 = new byte[stride * h];
                byte[] b2 = new byte[stride * h];
                Marshal.Copy(d1.Scan0, b1, 0, b1.Length);
                Marshal.Copy(d2.Scan0, b2, 0, b2.Length);
                prev.UnlockBits(d1); bmp.UnlockBits(d2);

                int changed = 0, minY = h, maxY = -1, minX = w, maxX = -1;
                for (int yy = 0; yy < h; yy++) {
                    int row = yy * stride;
                    for (int xx = 0; xx < w; xx++) {
                        int i = row + xx * 4;
                        if (b1[i] != b2[i] || b1[i + 1] != b2[i + 1] || b1[i + 2] != b2[i + 2]) {
                            changed++;
                            if (yy < minY) minY = yy;
                            if (yy > maxY) maxY = yy;
                            if (xx < minX) minX = xx;
                            if (xx > maxX) maxX = xx;
                        }
                    }
                }
                if (changed == 0) {
                    res.Add(string.Format("f{0,-3} dt={1,4}ms  changed=0", f, dt));
                } else {
                    PT cp; GetCursorPos(out cp);
                    res.Add(string.Format("{10}  f{0,-4} changed={2,7} ({3,5:0.00}%)  bbox=({4},{5})-({6},{7})",
                        f, dt, changed, changed * 100.0 / (w * h), minX, minY, maxX, maxY, cp.X, cp.Y, DateTime.Now.ToString("HH:mm:ss.fff")));
                }
                if (tail > 0 && tail <= 3) { bmp.Save(dir + "/seq" + tail + ".png", ImageFormat.Png); tail++; }
                if (changed > 20000 && shots < 1) {
                    prev.Save(dir + "/shot" + shots + "a.png", ImageFormat.Png);
                    bmp.Save(dir + "/shot" + shots + "b.png", ImageFormat.Png);
                    shots++; tail = 1;
                }
                prev.Dispose();
            }
            prev = bmp;
            System.Threading.Thread.Sleep(intervalMs);
        }
        if (prev != null) prev.Dispose();
        return res.ToArray();
    }
}
"@

# -ReferencedAssemblies must be explicit: inline C# does not reference
# System.Drawing by default, so using System.Drawing.Imaging fails to compile.
Add-Type -TypeDefinition $src -ReferencedAssemblies @('System.Drawing', 'System.Windows.Forms')

# Exclude self by PID and match board.ps1 exactly. Matching on command-line text
# alone keeps hitting THIS script, whose own command line contains the pattern.
$proc = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*board-wpf*' -and $_.CommandLine -notlike '*-Command*' } |
    Select-Object -First 1

$out = New-Object System.Collections.ArrayList
if (-not $proc) {
    [void]$out.Add('board not running')
} else {
    $h = [FlickerWatch]::FindForm([uint32]$proc.ProcessId)
    if ($h -eq [IntPtr]::Zero) {
        [void]$out.Add('no visible form')
    } else {
        # Deliberately NOT activating the window: activation itself forces a repaint
        $r = New-Object FlickerWatch+RECT
        [void][FlickerWatch]::GetWindowRect($h, [ref]$r)
        $w = $r.R - $r.L; $ht = $r.B - $r.T
        [void]$out.Add(('window ({0},{1}) {2}x{3}' -f $r.L, $r.T, $w, $ht))
        [void]$out.Add('list area starts around y=90 (header) / y=110 (first row)')
        [void]$out.Add('')

        # Full-speed pass over the LIST AREA ONLY. A transient erase-to-background
        # frame lasts a few ms, so 10fps sampling cannot see it; a smaller region
        # keeps each capture cheap enough to sample at ~100fps and catch it.
        $ly = $r.T
        $lh = $ht
        [void]$out.Add(('FAST PASS: list area only, y offset 95, h ' + $lh + ', no sleep'))
        [FlickerWatch]::dir = $PSScriptRoot
        $frames = [FlickerWatch]::Watch($r.L, $ly, $w, $lh, 1200, 0)
        $nonZero = @($frames | Where-Object { $_ -notmatch 'changed=0$' })
        [void]$out.Add(('frames captured = ' + $frames.Count + ', frames with any change = ' + $nonZero.Count))
        foreach ($line in $nonZero) { [void]$out.Add($line) }
    }
}
[IO.File]::WriteAllLines((Join-Path $PSScriptRoot 'flicker.txt'), $out, (New-Object System.Text.UTF8Encoding($false)))
