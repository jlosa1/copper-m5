import { describe, expect, it } from "vitest";
import { SINGLE_AGENT_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import {
  copperTools,
  refundAgentTools,
  singleAgentTools,
} from "@/lib/copper/assistant/tools";

const desk = { limitUsd: 50, refunds: [] };

describe("single support agent (Module 5)", () => {
  it("has every Copper tool and the refund tools, and no handoffs", () => {
    const names = Object.keys(singleAgentTools(desk));
    for (const name of Object.keys(copperTools)) expect(names).toContain(name);
    expect(names).toContain("get_orders");
    expect(names).toContain("request_refund");
    expect(names).not.toContain("transfer_to_refund_agent");
    expect(names).not.toContain("transfer_to_copper");
  });

  it("uses the same refund tools as the Refund agent", () => {
    const refund = Object.keys(refundAgentTools(desk));
    expect(refund).toContain("request_refund");
  });

  it("tells the agent to handle refunds itself, with the app deciding", () => {
    expect(SINGLE_AGENT_INSTRUCTIONS).toContain("request_refund");
    expect(SINGLE_AGENT_INSTRUCTIONS).toContain("The app decides");
    expect(SINGLE_AGENT_INSTRUCTIONS).not.toContain("transfer_to_refund_agent");
  });
});
