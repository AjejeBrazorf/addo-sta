# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People in Naples who already know roughly what they are looking for: a train, a bus, a stop, or a place they are headed to. They check it on a phone, often on the move, and want the answer in seconds.

## Product Purpose

Addò sta? answers the questions a traveller asks at a stop or station, fast and without losing detail:

- Which transport do I want: a train, a bus, or a stop?
- Where does this line take me? Show it as an ordered list of stops and as a path on the map.
- What is nearby me?
- Which transports pass this stop, and when?

Success: the answer to one of those questions is on screen within a couple of taps, and nothing the traveller needs is hidden to make the screen simpler.

## Positioning

One place for EAV rail and bus, ANM, and FS Linea 2, with live departures where the sources provide them. The user does not need to know which operator runs a line.

## Operating Context

Used on the go, usually on a phone with a patchy connection. Stop boards refresh on their own: station monitors and FS boards about every 20 seconds, ANM vehicle positions about every 10 seconds. When an upstream source is down or a prediction is missing, the screen says so.

## Capabilities and Constraints

- Search across EAV rail, EAV bus, ANM and FS Linea 2 stops, stations and lines.
- Live boards for EAV rail stations and FS Linea 2 stations.
- ANM stop boards show scheduled times from GTFS. BusOne predictions appear as "prev." with the scheduled time as "prog.".
- A line view lists its stops in order and draws its path on the map.
- Nearby stops are reachable from the map and the home screen.
- ANM vehicles on the map come from BusOne GPS and are labelled as measured positions.
- FS boards list only trains that run entirely within Linea 2, from Pozzuoli to San Giovanni a Barra.
- Non-commercial use only. The BusOne feed is sent with `X-BusOne-Use: personal`. The app is not public and is not offered to others.
- Italian only. No internationalisation work.

## Brand Commitments

None confirmed. The app is called "Addò sta?"; the page title is "Addò sta? · Napoli" and the favicon is `favicon.svg`.

## Evidence on Hand

- Live data sources wired in the server: EAV teleindicatori, ViaggiaTreno for FS Linea 2, BusOne GTFS-RT for ANM, and static GTFS for EAV and ANM.
- Static feeds: EAV open data (`wimob.it`) and ANM via the `f-s-anm~it` feed on transit.land.
- No user research, usage data, testimonials or brand guidelines exist in the repo. Do not invent them.

## Product Principles

- Speed first. The fastest path to the answer comes before any decoration, and every screen loads from one or two taps.
- Density without loss. Show every departure, stop and line detail the user needs, compactly, rather than hiding it behind extra taps.
- Say where data comes from and how fresh it is. Predictions and measured positions are always labelled.
- Only show what the sources cover. Do not imply real-time data for a network that has none.

## Accessibility & Inclusion

The screen is read on a phone in daylight, often while walking. Text must be large enough to read at a glance, contrast must hold outdoors, and the layout must not scroll sideways at 390px width. The board must be complete without relying on the map.
