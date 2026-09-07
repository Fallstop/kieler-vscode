/* Model assignments can retain an input pointer in another variable across ticks.
 * Own input strings for the simulation's lifetime, reusing equal values per slot.
 * Memory use follows distinct submitted strings, not the number of ticks. */
typedef struct KielerInputString {
    const void *slot;
    char *value;
    struct KielerInputString *next;
} KielerInputString;

static KielerInputString *kieler_input_strings = NULL;

static void kieler_free_input_strings(void) {
    while (kieler_input_strings != NULL) {
        KielerInputString *entry = kieler_input_strings;
        kieler_input_strings = entry->next;
        cJSON_free(entry->value);
        free(entry);
    }
}

static char *kieler_input_string(const void *slot, cJSON *item) {
    if (item->valuestring == NULL) return NULL;
    for (KielerInputString *entry = kieler_input_strings; entry != NULL; entry = entry->next) {
        if (entry->slot == slot && strcmp(entry->value, item->valuestring) == 0) return entry->value;
    }
    KielerInputString *entry = malloc(sizeof(*entry));
    if (entry == NULL) {
        fputs("Could not retain simulation string input: out of memory.\n", stderr);
        exit(EXIT_FAILURE);
    }
    if (kieler_input_strings == NULL) atexit(kieler_free_input_strings);
    entry->slot = slot;
    entry->value = item->valuestring;
    item->valuestring = NULL;
    entry->next = kieler_input_strings;
    kieler_input_strings = entry;
    return entry->value;
}
