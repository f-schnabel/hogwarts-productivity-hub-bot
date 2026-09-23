import { describe, expect, it, vi } from "vitest";
import { client } from "@/discord/client.ts";
import { sendAlert } from "@/discord/utils/alerting.ts";

describe("sendAlert", () => {
  it("sends operational alerts to the configured channel", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const fetchChannel = vi.spyOn(client.channels, "fetch").mockResolvedValue({
      isSendable: () => true,
      send,
    } as never);

    await sendAlert("Bot deployed successfully.");

    expect(fetchChannel).toHaveBeenCalledWith("alert-channel-id");
    expect(send).toHaveBeenCalledWith("Bot deployed successfully.");
  });

  it("rejects a missing or unsendable alert channel", async () => {
    vi.spyOn(client.channels, "fetch").mockResolvedValue(null);

    await expect(sendAlert("Failure")).rejects.toThrow(
      "Alert channel alert-channel-id was not found or cannot receive messages.",
    );
  });
});
