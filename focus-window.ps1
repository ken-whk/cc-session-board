# ASCII-only (see CLAUDE.md rule 3: PowerShell 5.1 mis-decodes non-BOM CJK).
#
# Restores and focuses the terminal window that owns a given Claude session.
#
# Why title matching instead of the process tree: on Windows the terminal host
# (VS Code / Windows Terminal / IDEA) talks to the shell over ConPTY and is NOT
# an ancestor of claude.exe. Measured on 2026-08-12, every live session's chain
# died before reaching any window-owning process:
#   claude.exe <- sh.exe <- DEAD
#   claude.exe <- winpty-agent.exe <- winpty.exe <- DEAD
# So the pid we have cannot be mapped to an HWND. Titles are the only link left.
#
# Two tiers, deliberately different in precision:
#   tier "title"  - Claude Code writes the session title into the console title,
#                   so mintty / Windows Terminal / bare cmd windows carry it
#                   verbatim (plus a leading status glyph). Exact per session.
#   tier "folder" - VS Code / JetBrains put the workspace name in the title but
#                   nothing about which terminal TAB is which. Window-level only;
#                   several sessions in one window all resolve to that window.
#
# Input is a UTF-8 JSON file, not command-line args: the session title is CJK and
# passing it through the process boundary depends on the console code page. The
# caller writes the file with fs.writeFileSync(..., 'utf8'); we read it as UTF8.
# Output is ASCII-only JSON on stdout - never echo the matched title back, that
# would put CJK on a stdout whose encoding we do not control.

param([Parameter(Mandatory = $true)][string]$Req)

$ErrorActionPreference = 'Stop'

# Compiling this C# on every call costs 422 ms (measured). Cache the assembly and
# just load it next time - loading a ready DLL is roughly free.
#
# The file name carries a version: editing the source below WITHOUT bumping it
# means every machine that already ran the old one keeps loading the stale DLL,
# and the change silently does nothing. Bump it, do not clean up the old file -
# it is in TEMP and costs a few KB.
$AsmPath = Join-Path $env:TEMP 'cc-board-focuswin-v1.dll'

$Src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FocusWin {
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@

if (-not (Test-Path -LiteralPath $AsmPath)) {
    # Two calls on the cold path: compile to disk, then load. Cheaper than it
    # looks - it happens once per machine, not once per click.
    Add-Type -TypeDefinition $Src -OutputAssembly $AsmPath
}
Add-Type -Path $AsmPath

# UTF-8 lines: title / host / folder candidates (most specific first, one per
# line). Shared verbatim with focus-window.cs, which is the fast path - keep both
# readers on the same format and the same matching order.
# Not JSON any more: ConvertFrom-Json plus a variable named like the [string]
# parameter silently coerced the parsed object back to a string, and every match
# failed with a perfectly plausible "no_match". Flat lines cannot do that.
function Read-Request([string]$path) {
    $lines = @(Get-Content -LiteralPath $path -Encoding UTF8)
    $folders = New-Object System.Collections.ArrayList
    for ($i = 2; $i -lt $lines.Count; $i++) {
        $f = ([string]$lines[$i]).Trim()
        if ($f.Length -gt 0) { [void]$folders.Add($f) }
    }
    return [pscustomobject]@{
        title   = if ($lines.Count -gt 0) { [string]$lines[0] } else { '' }
        host    = if ($lines.Count -gt 1) { ([string]$lines[1]).Trim() } else { '' }
        folders = $folders
    }
}

# Both sides get the same treatment, so stripping a leading bracket-style quote
# is harmless - what matters is that the two strings normalize identically.
# The status glyph Claude prepends (a spinner / dot) is exactly what this removes.
function Normalize-Title([string]$t) {
    if (-not $t) { return '' }
    $s = $t -replace '^[^\p{L}\p{N}]+', ''
    return $s.Trim()
}

function Get-Windows {
    # Get-Process, not Get-CimInstance Win32_Process: same pid -> name mapping,
    # but WMI costs 163 ms and this is free (measured). We only need the name,
    # none of the extra columns WMI carries.
    # ProcessName has no ".exe" suffix, so the patterns in Get-ProcPattern must
    # not depend on one - they are bare names for exactly this reason.
    $procs = @{}
    Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_.ProcessName }

    # The EnumWindows callback does the bare minimum: raw user32 calls plus an
    # Add. Do NOT call our own functions from inside it - an exception thrown in
    # a scriptblock invoked as a native delegate is swallowed silently, the list
    # comes back empty, and the caller sees a perfectly plausible "no_match"
    # with no error anywhere. Measured: calling Normalize-Title here produced
    # exactly that, and the titles involved were byte-identical.
    $raw = New-Object System.Collections.ArrayList
    $cb = [FocusWin+EnumProc] {
        param($h, $p)
        if ([FocusWin]::IsWindowVisible($h)) {
            $w = 0
            [void][FocusWin]::GetWindowThreadProcessId($h, [ref]$w)
            $sb = New-Object System.Text.StringBuilder 512
            [void][FocusWin]::GetWindowTextW($h, $sb, 512)
            $t = $sb.ToString()
            if ($t.Length -gt 0) {
                [void]$raw.Add(@($h, [int]$w, $t))
            }
        }
        return $true
    }
    [void][FocusWin]::EnumWindows($cb, [IntPtr]::Zero)

    $list = New-Object System.Collections.ArrayList
    foreach ($r in $raw) {
        [void]$list.Add([pscustomobject]@{
            H     = $r[0]
            Pid   = $r[1]
            Proc  = [string]$procs[[int]$r[1]]
            Title = [string]$r[2]
            Norm  = (Normalize-Title ([string]$r[2]))
        })
    }
    return $list
}

# Which process owns the window for a given host kind. Used only by the folder
# tier - the title tier does not care who owns the window, an exact title match
# is already stronger evidence than any process name.
function Get-ProcPattern([string]$kind) {
    switch ($kind) {
        'vscode'    { return 'Code|Code - Insiders' }
        'jetbrains' { return 'idea|pycharm|webstorm|goland|rider|clion|phpstorm|studio' }
        'wt'        { return 'WindowsTerminal' }
        'gitbash'   { return 'mintty' }
        'console'   { return 'conhost|cmd|powershell|OpenConsole' }
        default     { return '' }
    }
}

function Focus-Window($win) {
    # SW_RESTORE = 9. Only when minimized: calling it on a normal window would
    # un-maximize a maximized one, which is a visible regression nobody asked for.
    if ([FocusWin]::IsIconic($win.H)) { [void][FocusWin]::ShowWindow($win.H, 9) }

    # A bare SetForegroundWindow gets refused by the foreground lock: Windows
    # only lets the process that owns the current foreground window (or that got
    # the last input event) hand focus around. We are a short-lived child
    # process, so we are neither. Measured: returned false, window stayed put.
    #
    # Two standard unlocks, applied together because either alone still fails on
    # some window/host combinations:
    #   1. AttachThreadInput to the foreground thread - while attached we count
    #      as the same input queue, which satisfies the check.
    #   2. A synthetic ALT tap - Windows treats it as user input arriving at us,
    #      which also releases the lock. VK_MENU = 0x12, KEYEVENTF_KEYUP = 2.
    $fg = [FocusWin]::GetForegroundWindow()
    $fgThread = 0
    [void][FocusWin]::GetWindowThreadProcessId($fg, [ref]$fgThread)
    $me = [FocusWin]::GetCurrentThreadId()
    $attached = $false
    if ($fgThread -ne 0 -and $fgThread -ne $me) {
        $attached = [FocusWin]::AttachThreadInput($me, $fgThread, $true)
    }
    [FocusWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [FocusWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][FocusWin]::BringWindowToTop($win.H)
    [void][FocusWin]::SetForegroundWindow($win.H)
    if ($attached) { [void][FocusWin]::AttachThreadInput($me, $fgThread, $false) }

    # Report what actually happened, not what the API returned. SetForegroundWindow
    # returns true in cases where it merely flashed the taskbar button, and
    # claiming success on that would send the user hunting for a window that
    # never came up.
    # Poll instead of sleeping a flat 120 ms: the switch usually lands within one
    # or two ticks, and this is on the click-to-window path where every 10 ms shows.
    for ($i = 0; $i -lt 12; $i++) {
        if ([FocusWin]::GetForegroundWindow() -eq $win.H) { return $true }
        Start-Sleep -Milliseconds 10
    }
    return ([FocusWin]::GetForegroundWindow() -eq $win.H)
}

# hwnd is reported on purpose: VS Code runs every window in ONE process, so pid
# alone cannot tell two windows apart, and "did it pick the right window" is
# exactly the question worth asking when several are open.
$result = [ordered]@{ ok = $false; reason = 'no_match'; tier = ''; proc = ''; pid = 0; hwnd = 0 }

try {
    # Must NOT reuse the name $Req here. PowerShell variable names are
    # case-insensitive, so $req IS the script parameter - and a param declared
    # [string] keeps that type constraint for the rest of the script. Assigning
    # the parsed object back into it silently coerces the object to its string
    # form, after which .title is empty and every match fails with a completely
    # plausible "no_match". Measured: cost one debugging round.
    $reqObj = Read-Request $Req
    $wantTitle = Normalize-Title ([string]$reqObj.title)
    $folders = @($reqObj.folders)
    $kind = [string]$reqObj.host
    $wins = Get-Windows

    $hit = $null
    $tier = ''

    # Tier 1: exact normalized title. Strongest signal, host-agnostic.
    if ($wantTitle.Length -gt 0) {
        $hit = $wins | Where-Object { $_.Norm -eq $wantTitle } | Select-Object -First 1
        if ($hit) { $tier = 'title' }
        # A host may append its own suffix (some terminals add " - ProgramName").
        if (-not $hit) {
            $hit = $wins | Where-Object { $_.Norm -like ($wantTitle + '*') } | Select-Object -First 1
            if ($hit) { $tier = 'title' }
        }
    }

    # Tier 2: workspace folder name, restricted to processes that plausibly host
    # a terminal. Unrestricted substring matching would happily focus a browser
    # tab or an Explorer window that merely has the repo name in its title.
    # Candidates arrive most-specific-first (worktree name before repo name).
    # Stop at the first candidate that hits anything - taking the first window
    # matching ANY candidate would throw the ordering away. Same rule as the .cs.
    if (-not $hit -and $folders.Count -gt 0) {
        $pattern = Get-ProcPattern $kind
        foreach ($folder in $folders) {
            $cands = @($wins | Where-Object { $_.Title -like ('*' + $folder + '*') })
            if ($pattern.Length -gt 0) { $cands = @($cands | Where-Object { $_.Proc -match $pattern }) }
            if ($cands.Count -eq 0) { continue }
            # Prefer a window that is not minimized; fall back to z-order first.
            $hit = $cands[0]
            foreach ($c in $cands) { if (-not [FocusWin]::IsIconic($c.H)) { $hit = $c; break } }
            $tier = 'folder'
            break
        }
    }

    if ($hit) {
        $ok = Focus-Window $hit
        $result.ok = [bool]$ok
        $result.reason = if ($ok) { '' } else { 'focus_refused' }
        $result.tier = $tier
        $result.proc = $hit.Proc
        $result.pid = $hit.Pid
        $result.hwnd = [int64]$hit.H
    }
} catch {
    $result.ok = $false
    # Message may contain a localized (CJK) OS string - keep it off stdout.
    $result.reason = 'error'
}

$result | ConvertTo-Json -Compress
