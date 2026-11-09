# commands/

One module per `hubctl` subcommand. Each exports the command's entry function
(`runStatus`, `runLive`, `runReport`, …); `../hubctl.mjs` only dispatches, and
shared plumbing lives in `../common.mjs`. Behaviour and output formats are the
same as when the commands lived in the entry file — move code here, do not
rewrite it.
