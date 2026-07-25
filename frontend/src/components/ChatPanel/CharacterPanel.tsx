import React, { useState } from 'react';
import { X, Plus, Trash2, Check } from 'lucide-react';
import {
  type CharacterConfig,
  type CharacterCollection,
  CHARACTER_EMOTION_LIST,
  generateCharacterId,
  getCharacterList,
} from '@/lib/characterManager';
import styles from './panel.module.scss';

interface CharacterPanelProps {
  collection: CharacterCollection;
  onSave: (collection: CharacterCollection) => void;
  onClose: () => void;
}

const CharacterPanel: React.FC<CharacterPanelProps> = ({ collection, onSave, onClose }) => {
  const [col, setCol] = useState<CharacterCollection>(() => ({ ...collection }));
  const [editingId, setEditingId] = useState<string | null>(null);

  const characters = getCharacterList(col);
  const activeId = col.activeId;
  const editing = editingId ? col.items[editingId] : null;

  const handleSelect = (id: string) => {
    setCol({ ...col, activeId: id });
  };

  const handleDelete = (id: string) => {
    if (characters.length <= 1) return;
    const items = { ...col.items };
    delete items[id];
    const newActiveId = col.activeId === id ? Object.keys(items)[0] : col.activeId;
    setCol({ activeId: newActiveId, items });
    if (editingId === id) setEditingId(null);
  };

  const handleAdd = () => {
    const id = generateCharacterId();
    const newChar: CharacterConfig = {
      id,
      character_name: 'New Character',
      character_gender_desc: '',
      character_desc: '',
      character_emotion_list: [...CHARACTER_EMOTION_LIST],
      character_meta_info: { base_image_url: '' },
    };
    setCol({ ...col, items: { ...col.items, [id]: newChar } });
    setEditingId(id);
  };

  const handleSave = () => {
    onSave(col);
  };

  if (editing) {
    return (
      <CharacterEditor
        character={editing}
        onSave={(updated) => {
          setCol({ ...col, items: { ...col.items, [updated.id]: updated } });
          setEditingId(null);
        }}
        onClose={() => setEditingId(null)}
      />
    );
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>Characters</span>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className={styles.panelBody}>
          <div className={styles.listView}>
            {characters.map((char) => (
              <div
                key={char.id}
                className={`${styles.listItem} ${char.id === activeId ? styles.listItemActive : ''}`}
                onClick={() => handleSelect(char.id)}
              >
                <div className={styles.listItemAvatar}>
                  {char.character_meta_info?.base_image_url ? (
                    <img src={char.character_meta_info.base_image_url} alt={char.character_name} />
                  ) : (
                    <span>{char.character_name.charAt(0)}</span>
                  )}
                </div>
                <div className={styles.listItemInfo}>
                  <div className={styles.listItemName}>{char.character_name}</div>
                  <div className={styles.listItemDesc}>
                    {char.character_gender_desc || 'No gender set'}
                  </div>
                </div>
                <div className={styles.listItemActions}>
                  {char.id === activeId && (
                    <span className={styles.activeBadge}>
                      <Check size={12} />
                    </span>
                  )}
                  <button
                    className={styles.listItemBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(char.id);
                    }}
                    title="Edit"
                  >
                    Edit
                  </button>
                  {characters.length > 1 && (
                    <button
                      className={styles.listItemBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(char.id);
                      }}
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.panelFooter}>
          <button className={styles.addBtn} onClick={handleAdd}>
            <Plus size={14} /> New Character
          </button>
          <div style={{ flex: 1 }} />
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.saveBtn} onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Character Editor (single character editing form)
// ---------------------------------------------------------------------------

const CharacterEditor: React.FC<{
  character: CharacterConfig;
  onSave: (config: CharacterConfig) => void;
  onClose: () => void;
}> = ({ character, onSave, onClose }) => {
  const [name, setName] = useState(character.character_name);
  const [gender, setGender] = useState(character.character_gender_desc);
  const [desc, setDesc] = useState(character.character_desc);
  const [imageUrl, setImageUrl] = useState(character.character_meta_info?.base_image_url || '');
  const [emotions, setEmotions] = useState<string[]>([...character.character_emotion_list]);
  const [emotionImages, setEmotionImages] = useState<Record<string, string>>(() => {
    const images: Record<string, string> = { ...character.character_meta_info?.emotion_images };
    // Populate from emotion_videos (use first video URL) if emotion_images is missing
    const videos = character.character_meta_info?.emotion_videos;
    if (videos) {
      for (const [emotion, urls] of Object.entries(videos)) {
        if (!images[emotion] && urls?.length) {
          images[emotion] = urls[0];
        }
      }
    }
    return images;
  });
  const [emotionVideos, setEmotionVideos] = useState<Record<string, string[]>>(() => ({
    ...character.character_meta_info?.emotion_videos,
  }));
  const [newEmotion, setNewEmotion] = useState('');

  const handleAddEmotion = () => {
    const e = newEmotion.trim().toLowerCase();
    if (e && !emotions.includes(e)) {
      setEmotions([...emotions, e]);
      setNewEmotion('');
    }
  };

  const handleRemoveEmotion = (emotion: string) => {
    setEmotions(emotions.filter((e) => e !== emotion));
    const updatedImages = { ...emotionImages };
    delete updatedImages[emotion];
    setEmotionImages(updatedImages);
    const updatedVideos = { ...emotionVideos };
    delete updatedVideos[emotion];
    setEmotionVideos(updatedVideos);
  };

  const handleResetEmotions = () => {
    setEmotions([...CHARACTER_EMOTION_LIST]);
  };

  const updateEmotionImage = (emotion: string, url: string) => {
    setEmotionImages({ ...emotionImages, [emotion]: url });
  };

  const handleSave = () => {
    const cleanImages: Record<string, string> = {};
    for (const [k, v] of Object.entries(emotionImages)) {
      if (v?.trim()) cleanImages[k] = v.trim();
    }

    const cleanVideos: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(emotionVideos)) {
      if (v?.length) cleanVideos[k] = v;
    }

    onSave({
      id: character.id,
      character_name: name.trim() || 'Unnamed',
      character_gender_desc: gender.trim(),
      character_desc: desc.trim(),
      character_emotion_list: emotions,
      character_meta_info: {
        ...character.character_meta_info,
        base_image_url: imageUrl.trim() || undefined,
        emotion_images: Object.keys(cleanImages).length > 0 ? cleanImages : undefined,
        emotion_videos: Object.keys(cleanVideos).length > 0 ? cleanVideos : undefined,
      },
    });
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>Edit Character</span>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className={styles.panelBody}>
          {imageUrl && (
            <div className={styles.avatarPreview}>
              <img src={imageUrl} alt={name} className={styles.avatarImg} />
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label}>Name</label>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Character name"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Gender</label>
            <input
              className={styles.input}
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              placeholder="female / male / non-binary / ..."
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Persona Description</label>
            <textarea
              className={styles.textarea}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={6}
              placeholder="Describe the character's personality, background, speaking style..."
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Default Avatar (base image)</label>
            <input
              className={styles.input}
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>
              Emotions & Expressions
              <button className={styles.resetLink} onClick={handleResetEmotions}>
                Reset to defaults
              </button>
            </label>
            <div className={styles.emotionImageList}>
              {emotions.map((e) => (
                <div key={e} className={styles.emotionImageRow}>
                  <div className={styles.emotionImageHeader}>
                    <span className={styles.emotionTag}>
                      {e}
                      <button
                        className={styles.emotionRemove}
                        onClick={() => handleRemoveEmotion(e)}
                      >
                        <Trash2 size={10} />
                      </button>
                    </span>
                    {emotionImages[e] &&
                      (/\.(mp4|webm|mov|ogg)(\?|$)/i.test(emotionImages[e]) ? (
                        <video
                          src={emotionImages[e]}
                          className={styles.emotionThumb}
                          autoPlay
                          loop
                          muted
                          playsInline
                        />
                      ) : (
                        <img src={emotionImages[e]} alt={e} className={styles.emotionThumb} />
                      ))}
                  </div>
                  <input
                    className={styles.input}
                    value={emotionImages[e] || ''}
                    onChange={(ev) => updateEmotionImage(e, ev.target.value)}
                    placeholder={`Image/Video URL for "${e}" (optional)`}
                  />
                </div>
              ))}
            </div>
            <div className={styles.emotionAdd}>
              <input
                className={styles.input}
                value={newEmotion}
                onChange={(e) => setNewEmotion(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddEmotion()}
                placeholder="Add emotion..."
              />
              <button className={styles.addBtn} onClick={handleAddEmotion}>
                <Plus size={14} />
              </button>
            </div>
          </div>
        </div>

        <div className={styles.panelFooter}>
          <button className={styles.cancelBtn} onClick={onClose}>
            Back
          </button>
          <button className={styles.saveBtn} onClick={handleSave}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default CharacterPanel;
