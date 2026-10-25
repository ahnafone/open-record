# provider-remote

Client and `MusicSourceProvider` for the self-hosted Open Record download server
(`apps/server`). Searches supported sites, runs download jobs and hands the finished
file to the local import pipeline, so downloads become normal `local:` tracks.

Run `nx test provider-remote` to execute the unit tests.
