# Talos

Talos controls Claude sessions from another program.

In Greek myth, Talos was a bronze giant that guarded Crete and ran without
anyone steering it. This Talos keeps Claude sessions working the same way.

## Why

If a program can drive a Claude session, it can do almost anything with it:
- tell a session about a conversation it should join
- have a session work through a list of tasks, one after another
- start, stop, and check on sessions on any machine

Omicron (the task board) doesn't do this part well. Talos does this part and
nothing else.

## The plan

- **One central server** that controls everything. Every machine connects to
  it, and it tells their sessions what to do.
- **Safe remote control.** Only Joe, and programs Joe allows, can send orders
  to a session. Work this out first, before anything else gets built.

## Status

Just started. Nothing built yet.
