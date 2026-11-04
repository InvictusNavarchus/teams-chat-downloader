# Teams Chat Download

A planned CLI for exporting one-to-one and group chats from **Microsoft Teams Free with a personal Microsoft account** (`teams.live.com`).

The intended workflow is to select a chat, export a chosen date range, and download its images with a persistent cache so overlapping exports can reuse media.

## Project status

The project is in the research and design stage. No CLI, exporter, login helper, or credential store has been implemented, and there are no installation or usage commands yet.

The investigation verified direct HTTP requests for chat listing, historical messages, pagination, and image downloads. Playwright is intended to help with interactive login and credential acquisition. Credential renewal, participant-name lookup, and mapping message media references to download URLs still need investigation.

## Documentation

Start with the [research reference](docs/README.md) for the findings, protocol details, browser setup, proposed CLI design, validation plan, and sources. It distinguishes verified behavior from proposals and unresolved questions and serves as the implementation reference.

The [architecture plan](docs/07-architecture.md) records the agreed Bun, TypeScript, CAC, Zod, and Ky stack, module responsibilities, and the proposed first implementation milestone.

The findings concern private Teams endpoints observed on one account. They are not a published Microsoft API contract.
