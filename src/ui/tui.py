"""Textual TUI — terminal-based chat interface for MVP.

Provides a simple split-pane chat UI:
  - Left: chat history with styled bubbles
  - Right (or bottom): status panel (emotions, intimacy, memory stats)
  - Input bar at the bottom

Run with: python -m src.main
"""

from __future__ import annotations

import asyncio
import logging
import random
from datetime import datetime
from typing import TYPE_CHECKING

from ..config.settings import DATA_DIR
from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal, Vertical, ScrollableContainer
from textual.widgets import (
    Footer, Header, Input, Label, Static, Button,
)
from textual.reactive import reactive
from textual import events

if TYPE_CHECKING:
    from ..chat.session import ChatSession
    from ..chat.proactive import ProactiveChat
    from ..diary import DiaryManager
    from ..timeline import TimelineManager
    from ..web import WebSurfingManager
    from ..config.settings import _Settings
    from ..work_manager import WorkManager

import json
from pathlib import Path

logger = logging.getLogger("reverie.ui.tui")

# ── Styling constants ──────────────────────────────────────

USER_COLOR = "#4A90D9"       # Blue for user messages
CHARACTER_COLOR = "#D94A8A"  # Pink for character messages
SYSTEM_COLOR = "#888888"     # Grey for system messages
BG_COLOR = "#1a1a2e"
PANEL_BG = "#16213e"


# ── Widgets ────────────────────────────────────────────────

class ChatBubble(Static):
    """A single chat message bubble."""

    def __init__(self, sender: str, text: str, color: str, *args, **kwargs) -> None:
        self.sender = sender
        self.bubble_color = color
        super().__init__(text, *args, **kwargs)

    def compose(self) -> ComposeResult:
        yield Static(f"[{self.sender}]", classes="sender-label")
        yield Static(self.renderable, classes="bubble-text")


class StatusPanel(Static):
    """Right-side panel showing character status."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__("Loading...", *args, **kwargs)

    def update_status(
        self,
        emotions: dict[str, float],
        intimacy: int,
        memory_count: int,
        mood: str,
    ) -> None:
        top_emo = sorted(emotions.items(), key=lambda x: x[1], reverse=True)[:4]
        emo_lines = "\n".join(
            f"  {name:12s} [{'█' * int(v/10)}{'░' * (10 - int(v/10))}] {v:.0f}"
            for name, v in top_emo
        )

        stage = (
            "Acquaintance" if intimacy < 100 else
            "Familiar" if intimacy < 500 else
            "Close" if intimacy < 2000 else
            "Special Bond"
        )

        self.update(f"""\
[b]Mood:[/b] {mood}

[b]Emotions:[/b]
{emo_lines}

[b]Relationship:[/b] {stage}
  Intimacy: {intimacy}

[b]Memories:[/b] {memory_count} stored
""")


# ── App ────────────────────────────────────────────────────

class ReverieTUI(App):
    """Main Reverie terminal UI."""

    CSS = """
    Screen {
        background: #1a1a2e;
    }

    #chat-area {
        width: 70%;
        height: 100%;
        border: solid #2a2a4e;
        background: #16213e;
        overflow-y: scroll;
    }

    #status-panel {
        width: 30%;
        height: 100%;
        border: solid #2a2a4e;
        background: #0f3460;
        padding: 1;
    }

    #input-area {
        dock: bottom;
        height: 3;
        background: #0f3460;
    }

    #chat-input {
        width: 100%;
    }

    .user-bubble {
        background: #4A90D9;
        color: white;
        padding: 0 1;
        margin: 1 0;
    }

    .char-bubble {
        background: #D94A8A;
        color: white;
        padding: 0 1;
        margin: 1 0;
    }

    .system-text {
        color: #888888;
        text-style: italic;
        text-align: center;
    }

    .home-title {
        color: #f6d7ff;
        text-style: bold;
        padding: 1 1 0 1;
    }

    .home-card {
        background: #1f2a4a;
        color: #f4f1ff;
        border: round #4d5f91;
        padding: 1;
        margin: 1;
    }

    .home-muted {
        color: #aeb7d9;
        padding: 0 1;
    }

    .home-button {
        margin: 1;
        width: 24;
    }

    .warning-card {
        background: #3a2f18;
        color: #ffe7a8;
        border: round #b98b2f;
        padding: 1;
        margin: 1;
    }

    .diary-meta {
        color: #c4b5fd;
        padding: 0 1;
    }

    .timeline-event-daily {
        color: #93c5fd;
        border-left: solid #3b82f6;
        padding: 0 1;
        margin: 1 0;
    }

    .timeline-event-feelings {
        color: #fca5a5;
        border-left: solid #ef4444;
        padding: 0 1;
        margin: 1 0;
    }

    .timeline-event-story {
        color: #86efac;
        border-left: solid #22c55e;
        padding: 0 1;
        margin: 1 0;
    }

    .timeline-header {
        color: #e2e8f0;
        text-style: bold;
        padding: 1 1 0 1;
    }
    """

    def __init__(
        self,
        session: "ChatSession",
        proactive: "ProactiveChat | None" = None,
        *,
        diary: "DiaryManager | None" = None,
        timeline: "TimelineManager | None" = None,
        web_surfing: "WebSurfingManager | None" = None,
        settings: "_Settings | None" = None,
        work_manager: "WorkManager | None" = None,
    ) -> None:
        super().__init__()
        self._session = session
        self._proactive = proactive
        self._diary = diary
        self._timeline = timeline
        self._web_surfing = web_surfing
        self._settings = settings
        self._work_manager = work_manager
        self._running = True
        self._view = "home"

    def _late_night_active(self) -> bool:
        if self._work_manager is not None:
            return bool(getattr(self._work_manager, "late_night_active", False))
        return bool(self._proactive and getattr(self._proactive, "late_night_active", False))

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal():
            yield ScrollableContainer(id="chat-area")
            yield StatusPanel(id="status-panel")
        with Container(id="input-area"):
            yield Input(placeholder="Type /chat, /home, /diary, or enter a message...", id="chat-input")
        yield Footer()

    DRAFT_FILE = DATA_DIR / "draft.txt"

    def on_mount(self) -> None:
        """Called when the app is displayed."""
        self._update_status()
        self._show_home()

        # Restore draft input if exists (requirement #2)
        input_widget = self.query_one("#chat-input", Input)
        if self.DRAFT_FILE.exists():
            try:
                draft = self.DRAFT_FILE.read_text(encoding="utf-8").strip()
                if draft:
                    input_widget.value = draft
            except Exception:
                pass
        input_widget.focus()

        # Poll for proactive messages every 10 seconds
        if self._proactive:
            self.set_interval(10, self._check_proactive_messages)

    async def on_input_changed(self, event: Input.Changed) -> None:
        """Save draft on each keystroke (requirement #2)."""
        if event.value:
            try:
                self.DRAFT_FILE.parent.mkdir(parents=True, exist_ok=True)
                self.DRAFT_FILE.write_text(event.value, encoding="utf-8")
            except Exception:
                pass

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle user pressing Enter."""
        user_text = event.value.strip()
        if not user_text:
            return

        if user_text.lower() == "/home":
            event.input.value = ""
            self._show_home()
            return

        if user_text.lower() == "/chat":
            event.input.value = ""
            self._show_chat()
            return

        if user_text.lower() == "/diary":
            event.input.value = ""
            self._show_diary()
            return

        if user_text.lower() == "/timeline":
            event.input.value = ""
            self._show_timeline()
            return

        if user_text.lower() == "/settings":
            event.input.value = ""
            self._show_settings()
            return

        if self._view != "chat":
            self._show_chat()

        # Clear draft after submission
        event.input.value = ""
        try:
            self.DRAFT_FILE.unlink(missing_ok=True)
        except Exception:
            pass
        chat_area = self.query_one("#chat-area", ScrollableContainer)

        # Show user message immediately
        chat_area.mount(Static(f"You: {user_text}", classes="user-bubble"))
        typing_indicator = Static("typing...", classes="system-text")
        chat_area.mount(typing_indicator)
        # Scroll to bottom
        await self._scroll_to_bottom(chat_area)

        # Process through session
        try:
            result = await self._session.send_message(user_text)

            display_delay = max(
                float(result.get("delay", 0.0)),
                float(result.get("typing_duration", 0.0)),
            )
            if display_delay > 0:
                await asyncio.sleep(display_delay)

            # Remove "typing..." indicator after the simulated delay.
            try:
                typing_indicator.remove()
            except Exception:
                pass

            # Show reply (split into bubbles)
            for msg in result["messages"]:
                chat_area.mount(Static(
                    f"{self._session.persona.name}: {msg}", classes="char-bubble"
                ))

            self._update_status()
            await self._scroll_to_bottom(chat_area)

            # Occasional retraction (requirements #57-58)
            await self._maybe_retract_message(chat_area)

        except Exception as exc:
            try:
                typing_indicator.remove()
            except Exception:
                pass
            chat_area.mount(Static(
                f"[Error: {exc}]", classes="system-text"
            ))

    def _check_proactive_messages(self) -> None:
        """Periodic poll: check for proactive messages and display them."""
        if not self._proactive:
            return
        results = self._proactive.drain_pending()
        if not results:
            return

        if self._view != "chat":
            self._show_chat()

        chat_area = self.query_one("#chat-area", ScrollableContainer)
        for result in results:
            # Apply emotion changes
            self._session.emotion.apply_event(result.emotion_changes)
            self._session.emotion.tick()

            # Display each bubble
            for msg in result.messages:
                chat_area.mount(Static(
                    f"{self._session.persona.name}: {msg}", classes="char-bubble"
                ))
        self._update_status()
        self.call_later(self._scroll_to_bottom, chat_area)

    def _update_status(self) -> None:
        panel = self.query_one(StatusPanel)
        panel.update_status(
            emotions=self._session.emotion.values,
            intimacy=self._session.relationship.intimacy,
            memory_count=self._session.memory.store.count(),
            mood=self._session.emotion.get_mood_label(),
        )

    def _show_home(self) -> None:
        """Render the status-first home view.

        This keeps the current Textual UI close to a future Web UI shape:
        one view model gathers state, and the renderer decides presentation.
        """
        self._view = "home"
        chat_area = self.query_one("#chat-area", ScrollableContainer)
        self._clear_container(chat_area)
        state = self._build_home_state()

        chat_area.mount(Static(f"{state['name']}'s room", classes="home-title"))
        if state["show_web_disclaimer"]:
            chat_area.mount(Static(
                f"Web surfing disclaimer\n{state['web_disclaimer']}",
                classes="warning-card",
            ))
            chat_area.mount(Button(
                "I understand",
                id="accept-web-disclaimer",
                classes="home-button",
            ))
        chat_area.mount(Static(
            "\n".join([
                f"Mood: {state['mood']}",
                f"Status: {state['status']}",
                f"Activity: {state['activity']}",
                f"Relationship: {state['relationship_stage']} ({state['intimacy']})",
                f"Memories: {state['memory_count']}",
                f"Social Circle: {state['social_count']} contacts",
                f"Interests: {state['interest_count']} topics",
                f"Time: {state['time']}",
            ]),
            classes="home-card",
        ))
        chat_area.mount(Static(
            f"Latest timeline\n{state['latest_timeline']}",
            classes="home-card",
        ))
        chat_area.mount(Static(
            f"Latest diary\n{state['latest_diary']}",
            classes="home-card",
        ))
        chat_area.mount(Static(
            f"Diary privacy\n{state['diary_privacy']}",
            classes="home-card",
        ))
        chat_area.mount(Static(
            "Type /chat, /diary, /settings, press a button below, or just send a message to start talking.",
            classes="home-muted",
        ))
        chat_area.mount(Button("Open Chat", id="open-chat", classes="home-button"))
        chat_area.mount(Button("View Diary", id="open-diary-list", classes="home-button"))
        chat_area.mount(Button("View Timeline", id="open-timeline", classes="home-button"))
        chat_area.mount(Button("Settings", id="open-settings", classes="home-button"))
        chat_area.mount(Button("Refresh Home", id="refresh-home", classes="home-button"))
        self._update_status()

    def _show_chat(self) -> None:
        """Render the chat view while preserving the same session."""
        if self._view == "chat":
            return
        self._view = "chat"
        chat_area = self.query_one("#chat-area", ScrollableContainer)
        self._clear_container(chat_area)
        chat_area.mount(Static(
            f"Chat with {self._session.persona.name}. Type /home to return to her status.",
            classes="system-text",
        ))
        self._update_status()

    def _show_diary(self) -> None:
        """Render the diary date list page."""
        self._view = "diary"
        chat_area = self.query_one("#chat-area", ScrollableContainer)
        self._clear_container(chat_area)
        chat_area.mount(Static(f"{self._session.persona.name}'s diary", classes="home-title"))

        if not self._diary:
            chat_area.mount(Static("Diary system is not available.", classes="warning-card"))
            chat_area.mount(Button("Back Home", id="back-home", classes="home-button"))
            return

        late_night_active = self._late_night_active()
        entries_meta = self._diary.list_entries_with_metadata(
            status=self._session.scheduler.status,
            late_night_active=late_night_active,
        )
        if not entries_meta:
            chat_area.mount(Static("No diary entries yet.", classes="home-card"))
        else:
            privacy_status = self._diary.privacy_status(
                status=self._session.scheduler.status,
                late_night_active=late_night_active,
            )
            chat_area.mount(Static(
                f"Diary list ({len(entries_meta)} entries total)\n{privacy_status}",
                classes="home-card",
            ))
            if len(entries_meta) > 1:
                chat_area.mount(Static(
                    "Newest first. Choose a date to open the full entry.",
                    classes="home-muted",
                ))
            for meta in entries_meta:
                date_str = meta["date"]
                label = f"{date_str} [{meta['mood']}] {meta['status_label']}"
                chat_area.mount(Button(
                    label,
                    id=f"diary-{date_str}",
                    classes="home-button",
                ))
            if self._diary.list_missed():
                chat_area.mount(Static(
                    f"Missed queue: {', '.join(self._diary.list_missed())}",
                    classes="warning-card",
                ))

        chat_area.mount(Button("Back Home", id="back-home", classes="home-button"))
        chat_area.mount(Button("Open Chat", id="open-chat", classes="home-button"))
        chat_area.mount(Button("Settings", id="open-settings", classes="home-button"))
        self._update_status()

    def _show_diary_entry(self, date_str: str) -> None:
        """Render a single diary entry page."""
        self._view = "diary-entry"
        chat_area = self.query_one("#chat-area", ScrollableContainer)
        self._clear_container(chat_area)
        chat_area.mount(Static(f"{self._session.persona.name}'s diary", classes="home-title"))
        if not self._diary:
            chat_area.mount(Static("Diary system is not available.", classes="warning-card"))
            chat_area.mount(Button("Back Diary List", id="open-diary-list", classes="home-button"))
            return

        late_night_active = self._late_night_active()
        can_peek = self._diary.can_peek(
            status=self._session.scheduler.status,
            late_night_active=late_night_active,
        )
        privacy_status = self._diary.privacy_status(
            status=self._session.scheduler.status,
            late_night_active=late_night_active,
        )
        entry = self._diary.load_entry(date_str)
        if not entry:
            chat_area.mount(Static(f"No diary found for {date_str}.", classes="warning-card"))
        elif not can_peek:
            chat_area.mount(Static(
                "\n".join([
                    "The diary is locked.",
                    privacy_status,
                    "",
                    "Content stays hidden until the peek condition is met.",
                ]),
                classes="warning-card",
            ))
        else:
            chat_area.mount(Static(
                "\n".join([
                    f"{entry.date} [{entry.mood}]",
                    entry.title,
                    "",
                    entry.content,
                ]),
                classes="home-card",
            ))
            if entry.highlights:
                chat_area.mount(Static(
                    f"Highlights: {', '.join(entry.highlights)}",
                    classes="home-muted",
                ))
        chat_area.mount(Button("Back Diary List", id="open-diary-list", classes="home-button"))
        chat_area.mount(Button("Back Home", id="back-home", classes="home-button"))
        chat_area.mount(Button("Open Chat", id="open-chat", classes="home-button"))
        self._update_status()

    def _show_timeline(self) -> None:
        """Render the timeline page."""
        self._view = "timeline"
        chat_area = self.query_one("#chat-area", ScrollableContainer)
        self._clear_container(chat_area)
        chat_area.mount(Static("Timeline", classes="home-title"))

        if not self._timeline:
            chat_area.mount(Static("Timeline system is not available.", classes="warning-card"))
            chat_area.mount(Button("Back Home", id="back-home", classes="home-button"))
            return

        posts = self._timeline.get_recent(20)
        if not posts:
            chat_area.mount(Static("No timeline posts yet.", classes="home-card"))
        else:
            for post in reversed(posts):
                # Map event_type to css class and icon
                event_type = getattr(post, "event_type", "daily")
                if event_type == "feelings":
                    css_class = "timeline-event-feelings"
                    icon = "💭"
                elif event_type == "story":
                    css_class = "timeline-event-story"
                    icon = "📖"
                else:
                    css_class = "timeline-event-daily"
                    icon = "📱"

                header = f"{icon} {post.date} [{post.mood}]"
                chat_area.mount(Static(f"{header}\n{post.content}", classes=f"home-card {css_class}"))

        chat_area.mount(Button("Back Home", id="back-home", classes="home-button"))
        chat_area.mount(Button("Open Chat", id="open-chat", classes="home-button"))
        self._update_status()

    def _show_settings(self) -> None:
        """Render a lightweight settings page."""
        self._view = "settings"
        chat_area = self.query_one("#chat-area", ScrollableContainer)
        self._clear_container(chat_area)
        chat_area.mount(Static("Settings", classes="home-title"))
        if not self._settings:
            chat_area.mount(Static("Settings system is unavailable.", classes="warning-card"))
            chat_area.mount(Button("Back Home", id="back-home", classes="home-button"))
            return

        features = self._settings.features
        diary_privacy = "On" if features.diary_privacy_enabled else "Off"
        diary_peek = "Allowed" if features.diary_peek_enabled else "Blocked"
        web_state = "On" if features.web_surfing_enabled else "Off"
        late_night = "On" if features.late_night_enabled else "Off"
        length_stats = self._session.scheduler.get_length_stats()
        summary = "\n".join([
            f"Diary: {'On' if features.diary_enabled else 'Off'}",
            f"Diary privacy: {diary_privacy}",
            f"Diary peek: {diary_peek}",
            f"Web surfing: {web_state}",
            f"Late night: {late_night} ({features.late_night_probability:.2f})",
            f"Memory autonomous save: {'On' if features.autonomous_memory_enabled else 'Off'}",
            f"Memory LLM judge: {'On' if features.autonomous_memory_llm_enabled else 'Off'}",
            f"Allowed topics: {', '.join(features.web_allowed_topics)}",
            f"Refresh interval: {features.web_refresh_interval_minutes} min",
            f"Reply lengths: short {length_stats['short']} / medium {length_stats['medium']} / long {length_stats['long']}",
        ])
        chat_area.mount(Static(summary, classes="home-card"))
        chat_area.mount(Button("Toggle Diary", id="toggle-diary", classes="home-button"))
        chat_area.mount(Button("Toggle Privacy", id="toggle-diary-privacy", classes="home-button"))
        chat_area.mount(Button("Toggle Peek", id="toggle-diary-peek", classes="home-button"))
        chat_area.mount(Button("Toggle Web", id="toggle-web", classes="home-button"))
        chat_area.mount(Button("Topics: All Safe", id="topics-all", classes="home-button"))
        chat_area.mount(Button("Topics: Anime/Game", id="topics-anime-game", classes="home-button"))
        chat_area.mount(Button("Topics: Daily Fun", id="topics-daily-fun", classes="home-button"))
        chat_area.mount(Button("Refresh +30", id="web-refresh-up", classes="home-button"))
        chat_area.mount(Button("Refresh -30", id="web-refresh-down", classes="home-button"))
        chat_area.mount(Button("Toggle Late Night", id="toggle-late-night", classes="home-button"))
        chat_area.mount(Button("Late Night +", id="late-night-up", classes="home-button"))
        chat_area.mount(Button("Late Night -", id="late-night-down", classes="home-button"))
        chat_area.mount(Button("Toggle Memory Auto", id="toggle-memory-auto", classes="home-button"))
        chat_area.mount(Button("Toggle Memory LLM", id="toggle-memory-llm", classes="home-button"))
        chat_area.mount(Button("Back Home", id="back-home", classes="home-button"))
        self._update_status()

    def _build_home_state(self) -> dict[str, str | int | bool]:
        latest_timeline = "No timeline posts yet."
        if self._timeline:
            posts = self._timeline.get_recent(1)
            if posts:
                post = posts[-1]
                latest_timeline = f"{post.date} [{post.mood}]\n{post.content}"

        latest_diary = "No diary entries yet."
        diary_privacy = "Diary system is not available."
        if self._diary:
            entries = self._diary.get_recent_entries(1)
            if entries:
                entry = entries[0]
                latest_diary = f"{entry.date} [{entry.mood}]\n{entry.title}"
            late_night_active = self._late_night_active()
            diary_privacy = self._diary.privacy_status(
                status=self._session.scheduler.status,
                late_night_active=late_night_active,
            )
        activity = "idle"
        if self._view == "chat":
            activity = "chatting"
        elif self._view == "diary":
            activity = "looking at her diary"
        elif self._view == "diary-entry":
            activity = "reading a diary entry"
        elif self._view == "settings":
            activity = "checking settings"

        web_enabled = bool(
            self._settings
            and self._settings.features.web_surfing_enabled
            and self._web_surfing
        )
        web_acknowledged = bool(
            self._settings
            and self._settings.features.web_disclaimer_acknowledged
        )

        social_count = self._session.social.count if self._session.social else 0
        interest_count = self._session.interest.count if self._session.interest else 0

        return {
            "name": self._session.persona.name,
            "mood": self._session.emotion.get_mood_label(),
            "status": self._session.scheduler.status,
            "relationship_stage": self._relationship_stage(self._session.relationship.intimacy),
            "intimacy": self._session.relationship.intimacy,
            "memory_count": self._session.memory.store.count(),
            "social_count": social_count,
            "interest_count": interest_count,
            "time": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "latest_timeline": latest_timeline,
            "latest_diary": latest_diary,
            "diary_privacy": diary_privacy,
            "activity": activity,
            "show_web_disclaimer": web_enabled and not web_acknowledged,
            "web_disclaimer": self._web_surfing.get_disclaimer() if self._web_surfing else "",
        }

    def _relationship_stage(self, intimacy: int) -> str:
        if intimacy < 100:
            return "Acquaintance"
        if intimacy < 500:
            return "Familiar"
        if intimacy < 2000:
            return "Close"
        return "Special Bond"

    def _clear_container(self, container: ScrollableContainer) -> None:
        for child in list(container.children):
            child.remove()
        container.refresh(layout=True)

    def _acknowledge_web_disclaimer(self) -> None:
        if not self._settings:
            return
        self._settings.features.web_disclaimer_acknowledged = True
        try:
            from ..config.settings import save_settings
            save_settings(self._settings)
        except Exception:
            pass

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle home/settings/diary actions."""
        button_id = event.button.id or ""
        if button_id == "open-chat":
            self._show_chat()
        elif button_id == "open-diary" or button_id == "open-diary-list":
            self._show_diary()
        elif button_id == "open-timeline":
            self._show_timeline()
        elif button_id == "back-home":
            self._show_home()
        elif button_id == "refresh-home":
            self._show_home()
        elif button_id == "open-settings":
            self._show_settings()
        elif button_id == "accept-web-disclaimer":
            self._acknowledge_web_disclaimer()
            self._show_home()
        elif button_id == "toggle-diary":
            self._toggle_feature("diary_enabled")
        elif button_id == "toggle-diary-privacy":
            self._toggle_feature("diary_privacy_enabled")
        elif button_id == "toggle-diary-peek":
            self._toggle_feature("diary_peek_enabled")
        elif button_id == "toggle-web":
            self._toggle_feature("web_surfing_enabled")
        elif button_id == "topics-all":
            self._set_web_topics("all")
        elif button_id == "topics-anime-game":
            self._set_web_topics("anime_game")
        elif button_id == "topics-daily-fun":
            self._set_web_topics("daily_fun")
        elif button_id == "web-refresh-up":
            self._adjust_web_refresh(30)
        elif button_id == "web-refresh-down":
            self._adjust_web_refresh(-30)
        elif button_id == "toggle-late-night":
            self._toggle_feature("late_night_enabled")
        elif button_id == "late-night-up":
            self._adjust_late_night(0.01)
        elif button_id == "late-night-down":
            self._adjust_late_night(-0.01)
        elif button_id == "toggle-memory-auto":
            self._toggle_feature("autonomous_memory_enabled")
        elif button_id == "toggle-memory-llm":
            self._toggle_feature("autonomous_memory_llm_enabled")
        elif button_id.startswith("diary-"):
            self._show_diary_entry(button_id.removeprefix("diary-"))

    def _toggle_feature(self, name: str) -> None:
        if not self._settings or not hasattr(self._settings.features, name):
            return
        value = getattr(self._settings.features, name)
        if isinstance(value, bool):
            setattr(self._settings.features, name, not value)
            self._sync_runtime_settings()
            self._save_settings()
            self._show_settings()

    def _adjust_late_night(self, delta: float) -> None:
        if not self._settings:
            return
        current = self._settings.features.late_night_probability
        self._settings.features.late_night_probability = min(0.30, max(0.01, round(current + delta, 2)))
        self._sync_runtime_settings()
        self._save_settings()
        self._show_settings()

    def _set_web_topics(self, preset: str) -> None:
        if not self._settings:
            return
        if preset == "all":
            from ..web import SAFE_TOPICS
            self._settings.features.web_allowed_topics = list(SAFE_TOPICS)
        elif preset == "anime_game":
            self._settings.features.web_allowed_topics = ["新番/动漫资讯", "二次元内容", "游戏更新"]
        elif preset == "daily_fun":
            self._settings.features.web_allowed_topics = ["热门梗", "猫咪/宠物", "美食/料理", "科技趣闻"]
        self._sync_runtime_settings()
        self._save_settings()
        self._show_settings()

    def _adjust_web_refresh(self, delta: int) -> None:
        if not self._settings:
            return
        current = self._settings.features.web_refresh_interval_minutes
        self._settings.features.web_refresh_interval_minutes = min(1440, max(30, current + delta))
        self._sync_runtime_settings()
        self._save_settings()
        self._show_settings()

    def _sync_runtime_settings(self) -> None:
        if not self._settings:
            return
        features = self._settings.features
        if self._diary:
            self._diary.privacy_enabled = features.diary_privacy_enabled
            self._diary.peek_enabled = features.diary_peek_enabled
        if self._proactive:
            self._proactive.late_night_enabled = features.late_night_enabled
            self._proactive.late_night_probability = features.late_night_probability
            self._proactive.daily_limit = features.proactive_daily_limit
            self._proactive.min_interval_minutes = features.proactive_min_interval_minutes
            self._proactive.event_stories_enabled = features.proactive_event_stories_enabled
            if hasattr(self._proactive, "manage_status"):
                self._proactive.manage_status = not features.diary_enabled
        if self._work_manager:
            self._work_manager.apply_settings(features)
            if features.diary_enabled or features.late_night_enabled:
                self._work_manager.start()
            else:
                self._work_manager.stop()
        self._session.memory.autonomous_enabled = features.autonomous_memory_enabled
        self._session.memory.autonomous_llm_enabled = features.autonomous_memory_llm_enabled
        if features.web_surfing_enabled and self._web_surfing is None:
            try:
                from ..web import WebSurfingManager
                self._web_surfing = WebSurfingManager(
                    self._session.persona,
                    self._session.adapter,
                    allowed_topics=features.web_allowed_topics,
                    refresh_interval_minutes=features.web_refresh_interval_minutes,
                    search_windows=features.web_search_windows,
                )
            except Exception:
                logger.exception("Failed to initialize WebSurfingManager after enabling web surfing")
                features.web_surfing_enabled = False
                self._session.web = None
                return
        if self._web_surfing:
            from ..web import SAFE_TOPICS
            self._web_surfing.allowed_topics = [
                topic for topic in features.web_allowed_topics
                if topic in SAFE_TOPICS
            ] or self._web_surfing.allowed_topics
            self._web_surfing.refresh_interval_minutes = features.web_refresh_interval_minutes
            self._web_surfing.search_windows = list(features.web_search_windows)
            self._session.web = self._web_surfing if features.web_surfing_enabled else None

    def _save_settings(self) -> None:
        if not self._settings:
            return
        try:
            from ..config.settings import save_settings
            save_settings(self._settings)
        except Exception:
            pass

    async def _maybe_retract_message(self, chat_area: ScrollableContainer) -> None:
        """Occasionally retract and correct a message (requirements #57-58).

        With ~0.05% probability, the character retracts their last message
        and sends a quick correction, mimicking natural typo fixing.
        """
        if random.random() > 0.0005:
            return

        # Small delay before retracting
        await asyncio.sleep(random.uniform(2.0, 5.0))

        # Find the last character bubble and remove it
        children = list(chat_area.children)
        char_bubbles = [
            (i, c) for i, c in enumerate(children)
            if hasattr(c, "classes") and "char-bubble" in getattr(c, "classes", "")
        ]
        if not char_bubbles:
            return

        idx, last_bubble = char_bubbles[-1]
        original = last_bubble.renderable if hasattr(last_bubble, "renderable") else ""

        # Remove the last bubble
        last_bubble.remove()

        # Show retraction notice
        chat_area.mount(Static(
            f"{self._session.persona.name} recalled a message...",
            classes="system-text",
        ))
        await asyncio.sleep(random.uniform(0.5, 1.5))

        # Generate a short correction (don't call LLM, just modify text)
        if isinstance(original, str) and len(original) > 3:
            corrections = [
                f"Sorry, typo — {original}",
                f"Oops, let me rephrase: {original}",
                f"Ah, I meant: {original}",
            ]
            corrected = random.choice(corrections)
            chat_area.mount(Static(
                f"{self._session.persona.name}: {corrected}",
                classes="char-bubble",
            ))
            self._update_status()

    async def _scroll_to_bottom(self, container: ScrollableContainer) -> None:
        """Scroll the chat area to the bottom."""
        try:
            container.scroll_end(animate=False)
        except Exception:
            pass
