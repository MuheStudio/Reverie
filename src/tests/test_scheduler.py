import pytest
from src.chat.scheduler import MessageScheduler

def test_scheduler_init():
    scheduler = MessageScheduler(reply_delay_min=1.0, reply_delay_max=5.0)
    assert scheduler.reply_delay_min == 1.0
    assert scheduler.status == "online"

def test_calculate_delay():
    scheduler = MessageScheduler()
    # High emotion should reduce delay
    delay_normal = scheduler.calculate_delay(50, emotion_intensity=0.0)
    delay_high_emotion = scheduler.calculate_delay(50, emotion_intensity=1.0)
    
    # We can't strictly assert delay_high_emotion < delay_normal due to random base
    # but we can test status modifiers
    
    scheduler.set_status("sleeping")
    delay_sleep = scheduler.calculate_delay(50, emotion_intensity=0.0)
    assert delay_sleep > 10.0  # Sleeping multiplies by 10

def test_shape_reply_length():
    scheduler = MessageScheduler()
    
    # Short message should remain unchanged
    msg = "Hello!"
    shaped = scheduler.shape_reply_length(msg)
    assert shaped == msg
    
def test_split_message():
    scheduler = MessageScheduler(split_messages=True)
    
    # Short message
    assert len(scheduler.split_message("Hello world!")) == 1
    
    # Long message
    long_msg = "This is a very long message. " * 20
    splits = scheduler.split_message(long_msg)
    assert len(splits) > 1

def test_typing_duration():
    scheduler = MessageScheduler(typing_indicator=True)
    duration = scheduler.typing_duration(100)
    assert duration > 0.0
    
    scheduler.typing_indicator = False
    assert scheduler.typing_duration(100) == 0.0
