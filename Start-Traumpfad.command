#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  if [ -x "$HOME/.nvs/default/bin/node" ]; then
    export PATH="$HOME/.nvs/default/bin:$PATH"
  else
    print 'Bitte zuerst Node.js ab Version 22 installieren.'
    read '?Zum Schließen Enter drücken. '
    exit 1
  fi
fi
print 'Öffne nach dem Start http://localhost:5173 in deinem Browser.'
npm start
