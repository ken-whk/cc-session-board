// ASCII-only source. Compiled on first use into cc-board-focuswin-v1.exe by
// app/main.js (csc.exe from the in-box .NET Framework), then invoked directly.
//
// Why an exe instead of the PowerShell script next to it: measured on this
// machine, the .ps1 path costs ~870 ms per click, of which 478 ms is nothing but
// powershell.exe starting up. A plain .NET exe starts in tens of milliseconds.
// The .ps1 stays as a fallback for when csc is missing - same logic, same output
// shape, just slower. Keep the two in sync when changing matching rules.
//
// What it does: find the terminal window that owns a Claude session, restore it
// if minimized, bring it to the foreground. See focus-window.ps1's header for
// why this has to go through window titles rather than the process tree.
//
// Input: path to a UTF-8 text file - line 1 title, line 2 host, line 3 onwards
// workspace name candidates ordered most-specific-first.
// Not JSON: the title is CJK and parsing JSON here would mean either a
// dependency or a hand-rolled parser, for a handful of flat fields.
// Output: one line of ASCII JSON on stdout. Never echo the matched title back -
// stdout encoding is the caller's business, and it does not need it.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class FocusWindow
{
    private delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    private class Win
    {
        public IntPtr H;
        public int Pid;
        public string Proc = "";
        public string Title = "";
        public string Norm = "";
    }

    // Strips leading punctuation / symbols. Claude prepends a status glyph to the
    // console title, so the window carries "<glyph> <title>" while our record has
    // the bare title. Both sides run through this, so it does not matter whether
    // a legitimate leading bracket gets eaten - only that they agree.
    private static readonly Regex LeadingJunk = new Regex(@"^[^\p{L}\p{N}]+", RegexOptions.Compiled);

    private static string Normalize(string t)
    {
        if (string.IsNullOrEmpty(t)) return "";
        return LeadingJunk.Replace(t, "").Trim();
    }

    // Used only by the folder tier. Unrestricted substring matching would happily
    // focus a browser or an Explorer window that merely has the repo name in its
    // title, so candidates are limited to processes that can host a terminal.
    // Names come from Process.ProcessName, which carries no ".exe" suffix.
    // Is this character part of a "word" for boundary purposes? Hyphen and
    // underscore count as word characters on purpose: project names are routinely
    // joined with them ("oteapi-facade", "ote_api"), so treating them as separators
    // would defeat the whole check.
    private static bool IsWordish(char c)
    {
        return char.IsLetterOrDigit(c) || c == '-' || c == '_';
    }

    // Does `needle` occur in `hay` as a whole token, rather than merely as a substring?
    //
    // Why this exists: "oteapi" is a prefix of "oteapi-facade". With plain substring
    // matching both windows match the candidate "oteapi", and the winner is then
    // decided by z-order - so it silently focuses whichever project window you touched
    // last instead of failing consistently. Measured on a real setup: two JetBrains
    // project windows ("oteapi - ExternalController.java [oteapi]" and
    // "oteapi-facade - OteClient.java") live in ONE idea64 process, so the pid cannot
    // separate them either - the title is the only thing that can.
    //
    // Scans every occurrence, not just the first: the token-bounded hit may come later
    // in the title (JetBrains repeats the module name in trailing brackets).
    private static bool BoundedContains(string hay, string needle)
    {
        if (string.IsNullOrEmpty(hay) || string.IsNullOrEmpty(needle)) return false;
        int from = 0;
        while (from <= hay.Length - needle.Length)
        {
            int at = hay.IndexOf(needle, from, StringComparison.OrdinalIgnoreCase);
            if (at < 0) return false;
            int end = at + needle.Length;
            bool leftOk = at == 0 || !IsWordish(hay[at - 1]);
            bool rightOk = end >= hay.Length || !IsWordish(hay[end]);
            if (leftOk && rightOk) return true;
            from = at + 1;
        }
        return false;
    }

    private static string[] ProcNames(string kind)
    {
        switch (kind)
        {
            case "vscode": return new[] { "Code" };
            case "jetbrains": return new[] { "idea", "pycharm", "webstorm", "goland", "rider", "clion", "phpstorm", "studio" };
            case "wt": return new[] { "WindowsTerminal" };
            case "gitbash": return new[] { "mintty" };
            case "console": return new[] { "conhost", "cmd", "powershell", "OpenConsole" };
            default: return new string[0];
        }
    }

    private static List<Win> Enumerate()
    {
        var byPid = new Dictionary<int, string>();
        foreach (var p in Process.GetProcesses())
        {
            try { byPid[p.Id] = p.ProcessName; }
            catch { /* process died mid-enumeration; it cannot be our target anyway */ }
        }

        var list = new List<Win>();
        EnumWindows(delegate (IntPtr h, IntPtr lp)
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowTextW(h, sb, 512);
            var t = sb.ToString();
            if (t.Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string name;
            if (!byPid.TryGetValue((int)pid, out name)) name = "";
            list.Add(new Win { H = h, Pid = (int)pid, Proc = name, Title = t, Norm = Normalize(t) });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    private static bool Focus(IntPtr h)
    {
        // SW_RESTORE only when minimized: on a maximized window it would un-maximize,
        // which is a visible regression nobody asked for.
        if (IsIconic(h)) ShowWindow(h, 9);

        // A bare SetForegroundWindow is refused by the foreground lock - only the
        // process owning the current foreground window, or the one that got the
        // last input event, may hand focus around, and we are a short-lived child
        // of neither. Two standard unlocks applied together because either alone
        // still fails on some host/window combinations:
        //   1. AttachThreadInput - while attached we share the foreground input
        //      queue, which satisfies the check.
        //   2. A synthetic ALT tap - counts as user input arriving at us.
        uint fgThread = 0;
        var fg = GetForegroundWindow();
        if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out fgThread);
        uint me = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != 0 && fgThread != me) attached = AttachThreadInput(me, fgThread, true);

        keybd_event(0x12, 0, 0, UIntPtr.Zero);       // VK_MENU down
        keybd_event(0x12, 0, 2, UIntPtr.Zero);       // KEYEVENTF_KEYUP
        BringWindowToTop(h);
        SetForegroundWindow(h);

        if (attached) AttachThreadInput(me, fgThread, false);

        // Report what actually happened rather than the API's return value:
        // SetForegroundWindow reports success in cases where it merely flashed the
        // taskbar button, and claiming victory on that sends the user hunting for
        // a window that never came up.
        for (int i = 0; i < 12; i++)
        {
            if (GetForegroundWindow() == h) return true;
            Thread.Sleep(10);
        }
        return GetForegroundWindow() == h;
    }

    // hwnd is in here on purpose: VS Code runs every window in ONE process, so pid
    // alone cannot tell two windows apart - and "did it pick the right window" is
    // exactly the question worth asking when several are open.
    private static string Json(bool ok, string reason, string tier, string proc, int pid, IntPtr hwnd)
    {
        // proc is a process name (ASCII by construction); everything else is a
        // fixed literal. No escaping needed, and no user text ever reaches here.
        return "{\"ok\":" + (ok ? "true" : "false")
            + ",\"reason\":\"" + reason + "\""
            + ",\"tier\":\"" + tier + "\""
            + ",\"proc\":\"" + proc + "\""
            + ",\"pid\":" + pid
            + ",\"hwnd\":" + hwnd.ToInt64() + "}";
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length < 1) { Console.Out.WriteLine(Json(false, "error", "", "", 0, IntPtr.Zero)); return 0; }
            var lines = File.ReadAllLines(args[0], Encoding.UTF8);
            string wantTitle = Normalize(lines.Length > 0 ? lines[0] : "");
            string kind = lines.Length > 1 ? lines[1].Trim() : "";
            // Line 3 onwards: workspace name candidates, already ordered
            // most-specific-first by the caller.
            var folders = new List<string>();
            for (int i = 2; i < lines.Length; i++)
            {
                var f = lines[i].Trim();
                if (f.Length > 0) folders.Add(f);
            }

            var wins = Enumerate();
            Win hit = null;
            string tier = "";

            // Tier 1: exact normalized title. Strongest signal and host-agnostic -
            // Claude writes the session title into the console title, so mintty /
            // Windows Terminal / bare cmd carry it verbatim.
            if (wantTitle.Length > 0)
            {
                foreach (var w in wins)
                {
                    if (string.Equals(w.Norm, wantTitle, StringComparison.OrdinalIgnoreCase)) { hit = w; tier = "title"; break; }
                }
                if (hit == null)
                {
                    foreach (var w in wins)
                    {
                        if (w.Norm.StartsWith(wantTitle, StringComparison.OrdinalIgnoreCase)) { hit = w; tier = "title"; break; }
                    }
                }
            }

            // Tier 2: workspace folder name. Window-level only - VS Code and the
            // JetBrains IDEs put the workspace in the title but nothing about which
            // terminal TAB is which, so several sessions collapse onto one window.
            //
            // Candidates arrive most-specific-first (worktree name before repo name).
            // Walk them in order and stop at the first one that hits anything: with
            // one window per worktree that lands exactly, and with a single window on
            // the repo root it falls through to the old behaviour. Taking the first
            // window that matches ANY candidate would defeat the ordering entirely.
            if (hit == null && folders.Count > 0)
            {
                var names = ProcNames(kind);
                foreach (var folder in folders)
                {
                    var matched = new List<Win>();
                    foreach (var w in wins)
                    {
                        if (w.Title.IndexOf(folder, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        if (names.Length > 0)
                        {
                            bool okProc = false;
                            foreach (var n in names)
                            {
                                if (w.Proc.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0) { okProc = true; break; }
                            }
                            if (!okProc) continue;
                        }
                        matched.Add(w);
                    }
                    if (matched.Count == 0) continue;

                    // Within one candidate tier, a token-bounded hit beats a plain
                    // substring hit: "oteapi" must prefer "oteapi - Foo.java [oteapi]"
                    // over "oteapi-facade - Bar.java". Without this the tie is broken by
                    // z-order, i.e. it follows whichever window you last touched.
                    //
                    // Falling back to `matched` when nothing is bounded keeps every window
                    // that used to be reachable reachable - this only ever re-ranks.
                    var bounded = new List<Win>();
                    foreach (var w in matched)
                    {
                        if (BoundedContains(w.Title, folder)) bounded.Add(w);
                    }
                    var pool = bounded.Count > 0 ? bounded : matched;

                    // Several windows at the same specificity: prefer one that is
                    // not minimized - a minimized window is more likely the one
                    // just parked than the one being returned to. All minimized
                    // falls back to z-order first.
                    hit = pool[0];
                    foreach (var w in pool)
                    {
                        if (!IsIconic(w.H)) { hit = w; break; }
                    }
                    // Distinct tier when it had to settle for a loose match: nothing
                    // user-facing reads tier, but it is the only way to tell afterwards
                    // whether the pick was principled or a z-order coin flip.
                    tier = bounded.Count > 0 ? "folder" : "folder-loose";
                    break;
                }
            }

            if (hit == null) { Console.Out.WriteLine(Json(false, "no_match", "", "", 0, IntPtr.Zero)); return 0; }

            bool ok = Focus(hit.H);
            Console.Out.WriteLine(Json(ok, ok ? "" : "focus_refused", tier, hit.Proc, hit.Pid, hit.H));
            return 0;
        }
        catch (Exception)
        {
            // The message can be a localized (CJK) OS string - keep it off stdout.
            Console.Out.WriteLine(Json(false, "error", "", "", 0, IntPtr.Zero));
            return 0;
        }
    }
}
