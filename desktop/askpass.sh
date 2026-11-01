#!/bin/sh
# git asks for a user name or password through GIT_ASKPASS; answer with a
# native macOS dialog. Passwords are typed hidden.
case "$1" in
  Password*) hidden="with hidden answer" ;;
  *) hidden="" ;;
esac
exec /usr/bin/osascript -e "on run argv" -e "set r to display dialog (item 1 of argv) default answer \"\" $hidden with title \"placet-research\"" -e "return text returned of r" -e "end run" -- "$1"
