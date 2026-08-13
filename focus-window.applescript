-- ASCII-only source (same discipline as focus-window.ps1: keep non-ASCII out of
-- the script itself; the CJK session title arrives through a UTF-8 file).
--
-- macOS counterpart of focus-window.ps1 / .cs: bring the terminal window that
-- owns a Claude session to the front.
--
-- UNVERIFIED. Written without a Mac to test on. Everything here is derived from
-- the AppleScript dictionaries, not from a run. Two assumptions in particular
-- have never been observed:
--   1. that Claude Code's console title reaches Terminal.app's tab name /
--      custom title the same way it reaches mintty's window title on Windows;
--   2. that iTerm2's session name carries it too.
-- If either is false, the tab tiers degrade to plain app activation.
-- The caller treats any non-ok result as "do nothing special" and falls back to
-- opening the folder, which is exactly what macOS did before this script existed
-- -- so a wrong guess here cannot make things worse than they already were.
--
-- Input : path to a UTF-8 text file - line 1 title, line 2 host,
--         line 3+ workspace name candidates (most specific first).
--         Line 1 = "DIAG" switches to diagnostics: dump what is visible and
--         focus nothing. That is how this gets debugged remotely.
-- Output: one ASCII line on stdout, e.g. "ok=1 tier=tab app=Terminal".
--         Never echo the matched title back - it is CJK and the caller does not
--         need it.

on appIsRunning(appName)
	try
		tell application "System Events" to return (exists (processes whose name is appName))
	on error
		return false
	end try
end appIsRunning

-- Terminal.app: tab-level. This is the one place macOS can beat Windows, which
-- has no way to address an individual terminal tab at all.
on focusTerminalTab(wantTitle)
	if not appIsRunning("Terminal") then return ""
	try
		tell application "Terminal"
			repeat with w in windows
				repeat with t in tabs of w
					set nm to ""
					try
						set nm to custom title of t
					end try
					if nm is "" then
						try
							set nm to name of t
						end try
					end if
					if nm contains wantTitle then
						set selected tab of w to t
						set index of w to 1
						activate
						return "ok=1 tier=tab app=Terminal"
					end if
				end repeat
			end repeat
		end tell
	on error
		return ""
	end try
	return ""
end focusTerminalTab

on focusITermTab(wantTitle)
	if not appIsRunning("iTerm2") and not appIsRunning("iTerm") then return ""
	try
		tell application "iTerm"
			repeat with w in windows
				repeat with t in tabs of w
					repeat with s in sessions of t
						set nm to ""
						try
							set nm to name of s
						end try
						if nm contains wantTitle then
							select w
							select t
							select s
							activate
							return "ok=1 tier=tab app=iTerm"
						end if
					end repeat
				end repeat
			end repeat
		end tell
	on error
		return ""
	end try
	return ""
end focusITermTab

-- Editors: app-level only. Their windows carry the workspace name but nothing
-- about which integrated-terminal tab is which, so this is as precise as it gets
-- without Accessibility permission (AXRaise), which would add an install step.
on activateApp(appName)
	if not appIsRunning(appName) then return ""
	try
		tell application appName to activate
		return "ok=1 tier=app app=" & appName
	on error
		return ""
	end try
end activateApp

on diagnostics()
	set out to "DIAG"
	try
		if appIsRunning("Terminal") then
			tell application "Terminal"
				repeat with w in windows
					repeat with t in tabs of w
						set nm to ""
						try
							set nm to custom title of t
						end try
						set nm2 to ""
						try
							set nm2 to name of t
						end try
						set out to out & linefeed & "Terminal tab custom=[" & nm & "] name=[" & nm2 & "]"
					end repeat
				end repeat
			end tell
		else
			set out to out & linefeed & "Terminal not running"
		end if
	on error errMsg
		set out to out & linefeed & "Terminal error: " & errMsg
	end try
	try
		if appIsRunning("iTerm2") or appIsRunning("iTerm") then
			tell application "iTerm"
				repeat with w in windows
					repeat with t in tabs of w
						repeat with s in sessions of t
							set out to out & linefeed & "iTerm session name=[" & (name of s) & "]"
						end repeat
					end repeat
				end repeat
			end tell
		else
			set out to out & linefeed & "iTerm not running"
		end if
	on error errMsg
		set out to out & linefeed & "iTerm error: " & errMsg
	end try
	return out
end diagnostics

on run argv
	if (count of argv) is 0 then return "ok=0 reason=no_arg"
	set reqPath to item 1 of argv

	-- Read through the shell rather than `read ... as <<class utf8>>`: that
	-- literal needs non-ASCII guillemets in the source, which this file avoids.
	set raw to ""
	try
		set raw to do shell script "cat " & quoted form of reqPath
	on error
		return "ok=0 reason=read_fail"
	end try

	set ls to paragraphs of raw
	if (count of ls) is 0 then return "ok=0 reason=empty_req"

	set wantTitle to item 1 of ls
	if wantTitle is "DIAG" then return diagnostics()

	set theHost to ""
	if (count of ls) is greater than 1 then set theHost to item 2 of ls

	-- Tab tiers first: an exact-ish title match identifies the session itself,
	-- which is strictly better than raising whichever window the app feels like.
	if wantTitle is not "" then
		set r to focusTerminalTab(wantTitle)
		if r is not "" then return r
		set r to focusITermTab(wantTitle)
		if r is not "" then return r
	end if

	-- App tier, chosen by the host recorded at hook time.
	if theHost is "vscode" then
		set r to activateApp("Visual Studio Code")
		if r is not "" then return r
		set r to activateApp("Code")
		if r is not "" then return r
	else if theHost is "appleterminal" then
		set r to activateApp("Terminal")
		if r is not "" then return r
	else if theHost is "iterm" then
		set r to activateApp("iTerm2")
		if r is not "" then return r
		set r to activateApp("iTerm")
		if r is not "" then return r
	else if theHost is "jetbrains" then
		repeat with a in {"IntelliJ IDEA", "IntelliJ IDEA Ultimate", "PyCharm", "WebStorm", "GoLand", "RustRover", "CLion", "PhpStorm", "Rider"}
			set r to activateApp(a as text)
			if r is not "" then return r
		end repeat
	end if

	return "ok=0 reason=no_match"
end run
