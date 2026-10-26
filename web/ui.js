(() => {
  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }

  async function request(path, body, fallbackMessage = "The request failed.") {
    const response = await fetch(path, body === undefined ? undefined : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      const failure = new Error(result.error || fallbackMessage);
      failure.session = result.session;
      throw failure;
    }
    return result;
  }

  function renderSpeakerCards({ container, speakers, selectedId, name, onChange }) {
    container.replaceChildren();
    for (const speaker of speakers) {
      const card = node("label", undefined, "speaker-card");
      const radio = node("input");
      radio.type = "radio"; radio.name = name; radio.value = speaker.id;
      radio.checked = speaker.id === selectedId; radio.required = true;
      radio.addEventListener("change", () => onChange(speaker.id));
      const copy = node("span");
      copy.append(node("strong", speaker.speakerName), node("small", speaker.kind === "authored"
        ? "Authored persona" : `Persona · ${speaker.sourceCount} source${speaker.sourceCount === 1 ? "" : "s"}`));
      card.append(radio, copy);
      container.append(card);
    }
  }

  globalThis.DebateUI = Object.freeze({ node, request, renderSpeakerCards });
})();
