/** Same-origin channel used to hand an OAuth result back to the tab that started it. */
export const INTEGRATION_RETURN_CHANNEL = "zidaneai:integration-return";

export interface IntegrationReturnMessage {
  type: "zidaneai:integration-complete";
  platform: string;
  connected: boolean;
}
