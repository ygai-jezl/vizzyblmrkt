import { describe, expect, it } from "vitest";
import { editorHtmlToEmail, emailEditProblem, emailToEditorHtml } from "./emailDoc";

describe("emailToEditorHtml", () => {
  it("turns plain text into the paragraphs it is sent as", () => {
    expect(emailToEditorHtml("Hi {{first_name}},\nthanks for joining.\n\nSee you soon.")).toBe(
      "<p>Hi {{first_name}},<br>thanks for joining.</p>\n<p>See you soon.</p>",
    );
  });

  it("escapes plain text that looks like markup", () => {
    expect(emailToEditorHtml("Fish & chips for 2 > 1")).toBe("<p>Fish &amp; chips for 2 &gt; 1</p>");
  });

  it("keeps HTML the editor can hold, merge values included", () => {
    const html = '<h2>Welcome</h2><p>Hi <strong>{{first_name}}</strong>, <a href="{{unsubscribe_url}}">leave</a>.</p>';
    expect(emailToEditorHtml(html)).toBe(
      '<h2>Welcome</h2><p>Hi <strong>{{first_name}}</strong>, <a href="{{unsubscribe_url}}" target="_blank" rel="noopener noreferrer">leave</a>.</p>',
    );
  });

  it("is empty for an empty body", () => {
    expect(emailToEditorHtml("  \n ")).toBe("");
  });
});

describe("editorHtmlToEmail", () => {
  it("sanitizes what the editor hands back", () => {
    expect(editorHtmlToEmail('<p onclick="x()">Hi <a href="javascript:alert(1)">there</a></p><script>bad()</script>')).toBe(
      "<p>Hi <a>there</a></p>",
    );
  });

  it("keeps a centred paragraph", () => {
    expect(editorHtmlToEmail('<p style="text-align: center">Centred</p>')).toBe('<p style="text-align:center">Centred</p>');
  });

  it("saves an emptied editor as an empty body", () => {
    expect(editorHtmlToEmail("<p></p>")).toBe("");
    expect(editorHtmlToEmail("<p><br></p><p></p>")).toBe("");
  });
});

describe("emailEditProblem", () => {
  it("has nothing to say about plain text or HTML the editor keeps", () => {
    expect(emailEditProblem("Plain words, {{first_name}}.")).toBeNull();
    expect(
      emailEditProblem('<p style="text-align:center" class="lead">Hi</p><ul><li><a href="https://example.com" target="_blank" rel="noopener">x</a></li></ul>'),
    ).toBeNull();
  });

  it("names what it can't keep, once each, in order", () => {
    const html = '<table><tr><td><img src="https://example.com/a.png"></td></tr></table><p style="color:red">Hi</p><img src="b.png">';
    expect(emailEditProblem(html)).toEqual(["a table", "an image", "styles"]);
  });

  it("names the layout footer, comments and unknown tags", () => {
    expect(emailEditProblem('<p>Hi</p><div data-vzb-footer="1">Footer</div>')).toEqual(["the footer block", "a layout block"]);
    expect(emailEditProblem("<!--[if mso]><p>Outlook</p><![endif]-->")).toEqual(["HTML comments"]);
    expect(emailEditProblem("<p>Hi</p><marquee>old</marquee>")).toEqual(["<marquee>"]);
  });

  it("names settings on a link it would drop", () => {
    expect(emailEditProblem('<a href="https://example.com" data-track="1">x</a>')).toEqual(["HTML settings"]);
  });
});
