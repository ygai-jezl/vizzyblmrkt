import { describe, it, expect } from "vitest";
import {
  TEMPLATE_CATEGORIES,
  isTemplateCategory,
  templateCategoryLabel,
  DEFAULT_TEMPLATE_CATEGORY,
} from "./templateCategories";
import { TemplateCategoryId } from "@/lib/types/template";

describe("template categories", () => {
  it("validates ids", () => {
    expect(isTemplateCategory("educate")).toBe(true);
    expect(isTemplateCategory("challenge")).toBe(true);
    expect(isTemplateCategory("inform")).toBe(false);
    expect(isTemplateCategory("")).toBe(false);
  });

  it("labels known ids and passes through unknown", () => {
    expect(templateCategoryLabel("educate")).toBe("Educate");
    expect(templateCategoryLabel("xxx")).toBe("xxx");
  });

  it("default category is valid", () => {
    expect(isTemplateCategory(DEFAULT_TEMPLATE_CATEGORY)).toBe(true);
  });

  it("stays in sync with the Zod enum that validates a stored template", () => {
    const listIds = TEMPLATE_CATEGORIES.map((c) => c.id).sort();
    const enumIds = [...TemplateCategoryId.options].sort();
    expect(listIds).toEqual(enumIds);
  });
});
