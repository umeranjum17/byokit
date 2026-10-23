# Vision

## Who it is for

People who build apps that run on their users' own AI subscriptions, and the people who use those apps: someone who wants to bring their subscriptions into an application and connect their computer to a mobile or web application. Those users are not technical, so what they see has zero jargon and no technical setup step.

## The problem

Every new app rebuilds its own sign-in and its own way to reach the person's computer. Working across several subscriptions is the hard part, and each app ends up with another custom login and transport stack.

## Where we are going

A good set of packages any app can later use, that can be installed in any project and works seamlessly through the kit.

- **Runtime kits.** One wrapper per aggregator: [`@byokit/openclaw`](packages/openclaw) for products built on OpenClaw, and [`@byokit/herdr`](packages/herdr) for products built on Herdr. Each gives the app the full power of the aggregator underneath, so the customer's subscriptions are used by tools that already do the hard work of working across them.
- **Connection kits.** Pairing, relay, discovery, sealed data and headless UI states that work with either runtime kit rather than being rebuilt for every product.
- **Niche products on top.** A new product (a squad, a diagramming agent, a design agent) picks one runtime kit, reuses the connection kits, and writes only its own workflow and UI.

Success is a new application choosing the Herdr or OpenClaw integration and reusing the connection and account pieces it needs while owning its niche workflow, not another custom login and transport stack per app.

## Principles and quality bar

- **Full power, not a narrowed wrapper.** Typed helpers cover the common paths, and a typed pass-through covers the rest of the aggregator, so an app never has to fork the kit or go around it. Upstream pins advance through the kit, not around it.
- **The aggregator owns subscriptions.** A runtime kit exposes what its aggregator already provides instead of duplicating it in a competing provider layer. [`@byokit/accounts`](packages/accounts) stays for apps that talk to a provider directly.
- **No universal interface.** The kits share connection pieces and conventions, never a lowest-common-denominator API.
- **Installable in any project.** Plain published npm packages with no coupling to any one app. Each runtime kit ships a runnable example and a README that gets a new project working in minutes. Kits work alone and together.
- **Every account type its upstreams support,** plain and on by default. A subscription sign-in is not an API key: the two stay distinct, and API-billed routes are offered only when the app opts in.
- **Models come from the vendor, not our list.** Routes read the vendor's live model list or the wrapped tool's own list. An unknown model id warns, never blocks.
- **Self-hosted only.** No operated service. Apache-2.0, TypeScript across Node, React Native and the web.
- **Person and account isolation.** A kit never reads, copies or shares a person's credentials without their consent, and never touches their installed tools' state.
- **Ecosystem quality.** Stable semver APIs, docs, CI and security. Vendors are proven with automated tests, not live sign-ins. Small releases, often.
- **Names say what a kit does** (accounts, decide, link, reach, relay, seal, audio, speak); a third-party integration keeps the third party's name.

## What it is not

- Not a hosted service.
- Not a set of generic, non-AI platform kits.
- Not a single interface that forces every runtime to look the same.
- Not a competing provider layer on top of what an aggregator already does.
- Not an app: product workflows, UI and domain behavior stay in each application.

## Next milestones

Each lands as a small release; see [Releases](https://github.com/umeranjum17/byokit/releases).

1. **Chat keeps moving while a tool streams its input.** Move `@byokit/openclaw` to the first stable OpenClaw release that carries the upstream fix.
2. **Answer an agent's permission question from your phone.** Allow, Deny or Skip a blocked agent through `@byokit/herdr`, once a supported agent kind reports that it is waiting.
