"""`get_email_style` and `suggest_email_style` FunctionTools — Vizzy reads and suggests the Email style.

IMPORTANT (same as retrieve_knowledge.py): ADK resolves the parameter annotations
at runtime to find and strip the injected `tool_context`, so `ToolContext` must be
a real runtime import and this module must NOT use `from __future__ import
annotations`. The pure logic lives in email_style_client.py.
"""

from google.adk.tools import ToolContext

from . import email_style_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_email_style(tool_context: ToolContext) -> dict:
    """Read the brand's Email style: the logo, company name, header colour and button
    colour shared by every branded email (lifecycle, launch welcome, invites, newsletters
    and, where switched on, the sign-up confirmation and offboarding emails).

    Returns `current` (what emails wear now; null = the plain default look, with no
    header band), `pending` (a suggestion waiting for an admin to review), `fromBrandKit`
    (what "Use brand kit" would pick, with notes), the `logos` an email can show,
    `canSuggest` (only admins can suggest) and the page `url`. Call this before
    answering about the email style or suggesting a change. If `canSuggest` is false,
    say only an admin can suggest one instead of calling suggest_email_style.

    `headerOptions: true` means gradient headers, the header text colour and header
    images are on: `current` and `pending` then also carry `headerGradientColor` (null
    = a solid header), `headerText` ("auto", "white" or "black") and `headerImage` (the
    banner shown in place of the logo and name, as {id, title}; null = the colour
    header); `headerImages` lists the banners an admin uploaded on the page (id, title);
    and suggest_email_style can change them. Without it, they aren't switched on here yet.

    `themes: true` means email themes are on: `current` and `pending` then also carry
    `theme` ({preset, headingFont, bodyFont}; "classic" with the "system" font is
    today's look); `themePresets` lists the looks (id, label, their own fonts, page
    colour, card corners and button shape); `fonts` lists the fonts by id, where a
    "safe" one shows in every inbox and a "web" one only in Apple Mail, Outlook for Mac
    and a few others (the rest show its `fallback`, and every inbox does while web fonts
    aren't switched on, as the `note` says); and suggest_email_style can change the
    theme. Without it, themes and fonts aren't switched on here yet.
    """
    return client.get_style(_state(tool_context))


def suggest_email_style(
    mode: str,
    brief: str,
    tool_context: ToolContext,
    header_color: str = "",
    header_gradient_color: str = "",
    solid_header: bool = False,
    header_text_color: str = "",
    header_image: str = "",
    button_color: str = "",
    logo: str = "",
    company_name: str = "",
    hide_company_name: bool = False,
    theme: str = "",
    heading_font: str = "",
    body_font: str = "",
    use_brand_fonts: bool = False,
) -> dict:
    """Suggest an Email style for an admin to review and apply.

    It is ONLY a suggestion: emails don't change until an admin reviews and saves it
    on Brand › Email style. Never say it's live or applied. Only admins can suggest.

    Args:
        mode: "brand_kit" to start from the brand kit (e.g. "use my brand kit for my
            emails"), or "edit" to change the pending suggestion, else the saved style.
        brief: The operator's words, in a sentence.
        header_color: The band's colour as a hex like "#1b2a4a" (turn a colour name
            into a hex). Empty = keep.
        header_gradient_color: Only when get_email_style says `headerOptions`. The
            band fades from header_color (top left) to this hex (bottom right): for
            "a purple-to-indigo gradient", header_color is the purple and this the
            indigo. Hidden while a header image is in use (see header_image). Empty = keep.
        solid_header: True to remove the gradient, so the band is one colour again.
        header_text_color: Only when get_email_style says `headerOptions`. "white"
            or "black" for the name on the band, or "auto" to go back to whichever
            reads better. Hidden while a header image is in use. Empty = keep.
        header_image: Only when get_email_style says `headerOptions`. A banner's id
            from `headerImages`, shown as the header in place of the logo and name
            (header_color stays behind it), or "none" to go back to the colour header.
            You can't upload one: an admin uploads banners on Brand › Email style.
            While `current` or `pending` has a `headerImage`, the logo, name, gradient
            and header text colour don't show: to change those, ask whether to drop the
            banner and, if so, also send "none". Empty = keep.
        button_color: The button colour as a hex. Empty = keep.
        logo: "primary", "none", or a logo id from get_email_style. Empty = keep.
        company_name: The name shown beside the logo. Empty = keep.
        hide_company_name: True to show the logo alone, with no name.
        theme: Only when get_email_style says `themes`. A look from `themePresets`:
            "classic" (today's), "modern", "editorial" or "friendly" (for "make my
            emails feel more editorial", "editorial"). It brings its own heading and
            body fonts unless heading_font or body_font is given too. Empty = keep.
        heading_font: Only when get_email_style says `themes`. A font id from `fonts`
            (like "lora") for headings and the name on the header. Empty = keep.
        body_font: Only when get_email_style says `themes`. A font id from `fonts` for
            the email's text. Empty = keep.
        use_brand_fonts: Only when get_email_style says `themes`. True to take the
            heading and body fonts from Brand › Fonts where email has them (for "use my
            brand fonts in emails"); a heading_font or body_font given as well wins. The
            answer's warnings name any brand font email doesn't have (uploaded ones too).

    Send only what the operator asked to change.

    Returns:
        A status dict to relay (includes a card with a "Review and apply" link).
    """
    return client.suggest_style(
        _state(tool_context),
        mode,
        brief,
        header_color,
        button_color,
        logo,
        company_name,
        hide_company_name,
        header_gradient_color=header_gradient_color,
        solid_header=solid_header,
        header_text_color=header_text_color,
        header_image=header_image,
        theme=theme,
        heading_font=heading_font,
        body_font=body_font,
        use_brand_fonts=use_brand_fonts,
    )
