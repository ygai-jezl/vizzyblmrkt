import { describe, expect, it } from "vitest";
import { asciiTablesToMarkdown, hasAsciiTable } from "./asciiTables";

const WORKFLOW = [
  "+-------------------------------------------------------------------------+",
  "|                    Continuous Monitoring Workflow                       |",
  "+-------------------------------------------------------------------------+",
  "| 1. Query Definition    | Select brand and unbranded discovery prompts   |",
  "| 2. Execution Layer     | Run automated daily queries across AI engines   |",
  "| 3. Data Extraction     | Parse brand mentions, sentiment, and sources   |",
  "+-------------------------------------------------------------------------+",
].join("\n");

const COMPARISON = [
  "```",
  "+-------------------------------------------------------------------------+",
  "|                    Weekly Audits vs. Daily Monitoring                   |",
  "+-------------------------------------------------------------------------+",
  "| Metric                 | Weekly Sampling        | Daily Monitoring      |",
  "+------------------------+------------------------+-----------------------+",
  "| Source Overlap Captures| Under 25% overlap      | Full daily transition |",
  "| Anomaly Detection      | Confuses churn/trends  | Filters daily noise   |",
  "+-------------------------------------------------------------------------+",
  "```",
].join("\n");

describe("tables drawn out of characters", () => {
  it("become a titled list when the box has two columns and no header", () => {
    const { body, converted } = asciiTablesToMarkdown(`Intro.\n\n${WORKFLOW}\n\nAfter.`);
    expect(converted).toBe(1);
    expect(body).toBe(
      [
        "Intro.",
        "",
        "**Continuous Monitoring Workflow**",
        "",
        "- **1. Query Definition**: Select brand and unbranded discovery prompts",
        "- **2. Execution Layer**: Run automated daily queries across AI engines",
        "- **3. Data Extraction**: Parse brand mentions, sentiment, and sources",
        "",
        "After.",
      ].join("\n"),
    );
  });

  it("become a pipe table when the box has a header row, inside a code block too", () => {
    const { body, converted } = asciiTablesToMarkdown(COMPARISON);
    expect(converted).toBe(1);
    expect(body).toBe(
      [
        "**Weekly Audits vs. Daily Monitoring**",
        "",
        "| Metric | Weekly Sampling | Daily Monitoring |",
        "| --- | --- | --- |",
        "| Source Overlap Captures | Under 25% overlap | Full daily transition |",
        "| Anomaly Detection | Confuses churn/trends | Filters daily noise |",
      ].join("\n"),
    );
    expect(hasAsciiTable(COMPARISON)).toBe(true);
    expect(hasAsciiTable(body)).toBe(false);
  });

  it("join a wrapped cell to its row, and leave real code and Markdown tables alone", () => {
    const wrapped = ["+------+-------+", "| Name | Notes |", "+------+-------+", "| A    | first |", "|      | part  |", "+------+-------+"].join("\n");
    expect(asciiTablesToMarkdown(wrapped).body).toBe("| Name | Notes |\n| --- | --- |\n| A | first part |");
    const code = '```json\n{ "a": 1 }\n```';
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    for (const md of [code, table]) expect(asciiTablesToMarkdown(md)).toEqual({ body: md, converted: 0 });
  });
});
