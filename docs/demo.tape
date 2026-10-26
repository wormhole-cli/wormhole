# Demo GIF for the README and launch posts: vhs docs/demo.tape
# Needs: claude and codex logged in, wormhole on PATH, and a scratch project at ~/wormhole-demo.

Output docs/demo.gif
Set Shell zsh
Set FontSize 18
Set Width 1200
Set Height 640
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "mkdir -p ~/wormhole-demo && cd ~/wormhole-demo && clear" Enter
Show

Type "claude -p 'Plan a CLI that renames photos by date. Remember the codename SUNDIAL.'" Sleep 300ms Enter
Sleep 12s

Type "wormhole switch codex --no-launch" Sleep 300ms Enter
Sleep 3s

Type "codex exec resume --last 'What is the codename, and what were we building?'" Sleep 300ms Enter
Sleep 15s

Type "wormhole switch claude --no-launch" Sleep 300ms Enter
Sleep 3s

Type "wormhole status" Sleep 300ms Enter
Sleep 4s
