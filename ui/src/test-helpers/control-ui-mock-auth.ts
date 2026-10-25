import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";

export function normalizeControlUiMockAuth(
  scenario: Pick<
    ControlUiMockGatewayScenario,
    "deviceToken" | "authMethod" | "authMode" | "omitConnectHelloAuth"
  >,
) {
  return {
    // Prepared scenarios are normalized again before serialization; preserve explicit omission.
    deviceToken:
      scenario.deviceToken === null ? null : scenario.deviceToken?.trim() || "e2e-device-token",
    authMethod: scenario.authMethod ?? "token",
    authMode: scenario.authMode ?? null,
    omitConnectHelloAuth: scenario.omitConnectHelloAuth ?? false,
  };
}
