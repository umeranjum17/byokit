- Every type an entry hands a caller is now nameable from that entry, and none of them carries `any`.
  `.` exports `GatewayMethods`, `RouteView`, `RouteFacts`, `JsonValue`, `UsageClient` and `DayUsageClient`;
  `./device` exports `OpenClawDevice` and `DeviceEndFrame`; `./link` exports `OpenClawLinkOptions`,
  `OpenClawLinkHost`, `OpenClawServeOptions` and `OpenClawServeHandle`; `./testing` exports `FakeGateway`,
  `FakeHandler`, `FakeParams` and `StubRequest`, types `fakeGateway`'s script per method, and records each
  stubbed request as a typed `StubRequest` instead of `any`. An app can write its own generic wrapper over
  `call` and annotate what `routes()`, `openclawDevice()` and `openclawLink()` return without a cast. The
  Gateway slots the pinned engine does not declare stay `unknown` and are listed per release in
  `src/generated/report.json`; the README now says so beside the API table.