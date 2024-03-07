/*@nomin*/

mwjson.editor = class {
	constructor(config) {
		var defaultConfig = {
			target_slot: 'main',
			target_namespace: 'Item',
			mode: "default", // options: default, query
			submit_enabled: true, //if true, add save button
			allow_submit_with_errors: true,
			lang: mw.config.get('wgUserLanguage'),
			user_id: mw.config.get('wgUserName'),
			id: 'json-editor-' + mwjson.util.getShortUid(),
			onsubmit: (json) => this.onsubmit(json),
			onchange: (json) => {},
			onEditInline: null, //callback to edit a connected entity directly from the current entity edit form
			onCreateInline: null, //callback to create a new connected entity directly from the current entity edit form
			getSubjectId: (params) => { //callback to determine the currently edited subjects @id
				//params.jsondata : Current json content of the editor
				//params.editor : The mwjson editor instance
				return params.editor.config.target_namespace + ":" + mwjson.util.OswId(params.jsondata.uuid);
			}
		};
		this.config = mwjson.util.mergeDeep(defaultConfig, config);
		this.flags = {'change-after-load': false};
		this.addCss();
		if (this.config.container) {
			this.container = this.config.container;
			this.config.popup = false;
		}
		else {
			this.createPopupDialog(this.config.popupConfig);
			this.container = document.getElementById(this.config.id);
			this.config.popup = true;
		}

		this.jsonschema = new mwjson.schema({jsonschema: this.config.schema, config: {mode: this.config.mode, lang: this.config.lang}, debug: true});
		this.jsonschema.bundle()
			.then(() => this.jsonschema.preprocess())
			.then(() => {
				console.log("create editor");
				this.createEditor();
				this.createUI();
			})
			.catch((err) => {
				console.error(err);
			});
		console.log("constructor done");
	}

	createEditor() {
		//return function(err, config) {

		//console.log(this);

		//JSONEditor.defaults.language = "de";
		this.config.JSONEditorConfig = this.config.JSONEditorConfig || {};
		
		// object_background: "bg-dark",
		var defaultJSONEditorConfig = {
			theme: 'bootstrap5',
			iconlib: "spectre",
			remove_button_labels: true,
			ajax: true,
			ajax_cache_responses: false,
			disable_collapse: false,
			disable_edit_json: true,
			disable_properties: true,
			use_default_values: true,
			required_by_default: false,
			display_required_only: false,
			show_opt_in: true,
			show_errors: 'always',
			disable_array_reorder: false,
			disable_array_delete_all_rows: false,
			disable_array_delete_last_row: false,
			keep_oneof_values: false,
			no_additional_properties: true,
			case_sensitive_property_search: false,
			form_name_root: this.jsonschema.getSchema().id,
			//custom settings
			user_language: this.config.lang,
		}
		this.config.JSONEditorConfig = mwjson.util.mergeDeep(defaultJSONEditorConfig, this.config.JSONEditorConfig);
		this.config.JSONEditorConfig.schema = this.jsonschema.getSchema(),
		console.log(this.config.JSONEditorConfig);

		//create editor
		this.jsoneditor = new JSONEditor(this.container, this.config.JSONEditorConfig);
		this.jsoneditor.mwjson_editor = this; //store back ref
		console.log(this.config.data);

		// listen for loaded
		this.jsoneditor.on('ready', () => {
			console.log("Editor loaded");
			this.flags["change-after-load"] = true;
			console.log(this.jsoneditor);
			if (this.config.data) this.jsoneditor.setValue(this.config.data);
			if (this.config.target) mwjson.api.getPage(this.config.target).then((page) => {
				//return;
				if (page.content_model[this.config.target_slot] === 'wikitext') {
					mwjson.parser.parsePage(page);
					this.targetPage = page;
					//load data from page if exist
					if (this.targetPage.content !== "") {
						console.log("Load data:", this.targetPage.dict);
						var schemaJson = mwjson.editor.mwjson.parser.wikiJson2SchemaJson(this.targetPage.dict);
						console.log(schemaJson);
						this.jsoneditor.setValue(schemaJson);
					}
				}
				if (page.content_model[this.config.target_slot] === 'json') {
					console.log(page.slots[this.config.target_slot]);
					this.jsoneditor.setValue(page.slots[this.config.target_slot] ? page.slots[this.config.target_slot] : {});
				}
			})
			this.updateSubjectId();
		});

		// listen for changes
		this.jsoneditor.on('change', () => {
			console.log("Editor changed");
			console.log(this.jsoneditor.schema);
			console.log(this.jsoneditor.getValue());
			//console.log(this.jsoneditor.editors);

			this.updateSubjectId();

			var labeled_inputs = [];
			var label_requests = [];

			var all_editors = [];
			for (var subeditor_path of Object.keys(this.jsoneditor.editors)) {
				var e = this.jsoneditor.editors[subeditor_path]
				if (e) {
					all_editors.push(e)
					if (e.editors) all_editors = all_editors.concat(e.editors); // actual multiple editors due to oneOf schema
				}
			}

			for (var subeditor of all_editors) {

				var input = subeditor.input
				var $input = $(input);

				if (subeditor.schema?.dynamic_template) {
					var jseditor_editor = subeditor;
					var watched_values = subeditor.watched_values;
					this.formatDynamicTemplate(jseditor_editor, watched_values);
				}
				// add globals (does not work here since watched_values is evaluated before)
				/*if (subeditor.watched_values) {
					subeditor.watched_values["_current_subject_"] = this.config.target;
				}*/

				//collect autocomplete field values to fetch labels
				if (subeditor.format === 'autocomplete') {// && this.flags["change-after-load"]) {
					//console.log("Autocomplete Editor:", subeditor);
					//console.log("Dirty: ", subeditor.is_dirty, input.value, input.value_id, input.value_label, subeditor.value);
					if (subeditor.is_dirty && subeditor.value && subeditor.value !== "" && !input.value_id) {
						//field was not filled yet.
						//user has entered a value in the field but did not select a result from the suggestion list
						//reset the state if the input to empty
						subeditor.is_dirty = false;
						input.value = "";
						subeditor.value = "";
						subeditor.onChange(true);
					}
					else if (subeditor.is_dirty && input.value === "" && subeditor.value === "") {
						//field was already filled yet.
						//user has removed the value from field so it's now empty
						//reset the state if the input to empty
						subeditor.is_dirty = false;
						input.value_id = null;
						input.value_label = null;
						subeditor.onChange(true);
					}
					else if (input.value_id && input.value_label) { //label already fetched 
						input.value = input.value_label;
						subeditor.value = input.value_id; //will be applied on the next .getValue() call
						if (subeditor.is_dirty) {
							//field was already filled yet.
							//user has entered a new value in the field but did not select a result from the suggestion list
							//reset the field to the previous value
							subeditor.onChange(true);
						}
						subeditor.is_dirty = false;
					}
					else if (subeditor.value !== ""){
						labeled_inputs.push({input: input, value_id: subeditor.value});
						label_requests.push(subeditor.value);
					}

					var categories = subeditor.schema?.range;
					if (!categories) categories = subeditor.schema?.options?.autocomplete?.category; //legacy
					var super_categories = subeditor.schema?.subclassof_range; //indicates to create a new category of type range (MetaCategory) as subcategory of subclassof_range

					// create button to create an instance of the target category inline of not explicite disabled
					if (!(subeditor.schema?.options?.autocomplete?.create_inline === false) && (categories || super_categories) && !subeditor.inline_create_build && this.config.onCreateInline && this.config.onEditInline){
						subeditor.inline_create_build = true;

						// in order to add a button beside the autocomplete input field we have to rearrange the elements
						var $autocomplete_div = $input.parent();
						var $form_group = $input.parent().parent();
						var $form_group_label = $input.parent().parent().find("label");
						var $container = $(`<div style="display: flex;"></div>`)
						var $create_inline_button = $(`<div class="col-md-2"><button type="button" class="inline-edit-btn btn btn-secondary"></button></div>`);
						if ($form_group_label.length) {
							$container.insertAfter($form_group_label); // normal layout
							$autocomplete_div.addClass("col-md-10");
						}
						else $form_group.append($container); // table layout
						$container.append($autocomplete_div.detach());
						$container.append($create_inline_button);

						$create_inline_button.on("click", (function (subeditor, e) {
							//console.log("Click ", subeditor);
							var categories = subeditor.schema?.range ? subeditor.schema?.range : subeditor.schema?.options?.autocomplete?.category;
							if (categories && !Array.isArray(categories)) categories = [categories];
							var super_categories = subeditor.schema?.subclassof_range;
							if (super_categories && !Array.isArray(super_categories)) super_categories = [super_categories];
							// note: is_dirty === true indicates there is some user input in the field but no element from the suggestion list was picked
							// so subeditor.value would be the search string and no valid page name
							if (subeditor.value && !subeditor.is_dirty) {
								//osl.ui.editData({source_page: subeditor.value, reload: false}).then((page) => {
								this.config.onEditInline({page_title: subeditor.value}).then((page) => {
									//console.log(page);
									subeditor.value = page.title;
									// force label refreshing
									// we could also get the label from the returned page object
									subeditor.input.value_label = null;
									//subeditor.change();
									subeditor.onChange(true)
								});
							}
							else {
								//osl.ui.createOrQueryInstance(categories, "inline").then((page) => {
								this.config.onCreateInline({categories: categories, super_categories: super_categories}).then((page) => {
									//console.log(page);
									subeditor.value = page.title;
									// force label refreshing
									// we could also get the label from the returned page object
									subeditor.input.value_label = null;
									//subeditor.change();
									subeditor.onChange(true)
								});
							}
						}).bind(this, subeditor));
					}
				}

				//collect autocomplete field values to fetch labels
				if (subeditor.schema?.format === 'url' && subeditor.schema?.options?.upload) {
					if (!(subeditor.schema?.options?.upload?.create_inline === false) && !subeditor.inline_create_build && this.config.onCreateInline && this.config.onEditInline) {
						subeditor.inline_create_build = true;
						// in order to add a button beside the autocomplete input field we have to rearrange the elements
						var $container = $input.parent().find(".input-group");
						$input.parent().find(".json-editor-btn-upload").removeClass('json-editor-btn-upload');

						var $create_inline_button = $(`<button type="button" class="inline-edit-btn btn btn-secondary"></button>`);
						$container.append($create_inline_button);
						$create_inline_button.on("click", (function (subeditor, e) {
							//console.log("Click ", subeditor);
							var categories = subeditor.schema?.range ? subeditor.schema?.range : "Category:OSW11a53cdfbdc24524bf8ac435cbf65d9d"; // WikiFile default
							if (!Array.isArray(categories)) categories = [categories];
							// note: is_dirty === true indicates there is some user input in the field but no element from the suggestion list was picked
							// so subeditor.value would be the search string and no valid page name
							if (subeditor.value && !subeditor.is_dirty) {
								//osl.ui.editData({source_page: subeditor.value, reload: false}).then((page) => {
								this.config.onEditInline({page_title: subeditor.value}).then((page) => {
									//console.log(page);
									subeditor.value = page.title;
									// force label refreshing
									// we could also get the label from the returned page object
									subeditor.input.value_label = null;
									subeditor.change();
								});
							}
							else {
								//osl.ui.createOrQueryInstance(categories, "inline").then((page) => {
								this.config.onCreateInline({categories: categories}).then((page) => {
									//console.log(page);
									subeditor.value = page.title;
									// force label refreshing
									// we could also get the label from the returned page object
									subeditor.input.value_label = null;
									subeditor.change();
								});
							}
						}).bind(this, subeditor));
					}
				}

				// change label of inline create btn depending on the fields state
				if (
					(!(subeditor.schema?.options?.autocomplete?.create_inline === false) && (categories || super_categories) && this.config.onCreateInline && this.config.onEditInline)
					|| (!(subeditor.schema?.options?.upload?.create_inline === false) && subeditor.schema?.format === 'url' && subeditor.schema?.options?.upload && this.config.onCreateInline && this.config.onEditInline)
					){
					var label = mw.message("mwjson-editor-create-inline-label").text() + " " + '<i class="icon icon-plus"></i>';
					var tooltip = mw.message("mwjson-editor-create-inline-tooltip").text();
					if (subeditor.value && !subeditor.is_dirty) label = mw.message("mwjson-editor-edit-inline-label").text() + " " + '<i class="icon icon-edit"></i>';
					if (subeditor.value && !subeditor.is_dirty) tooltip = mw.message("mwjson-editor-edit-inline-tooltip").text();
					$input.parent().parent().find(".inline-edit-btn").html(label);
					$input.parent().parent().find(".inline-edit-btn").attr('title', tooltip);
				}

				//BUG: Does not save value in original text field (only if source mode is toggled). See PageForms extension
				if (subeditor.options && subeditor.options.wikieditor === 'visualeditor') {
					if (!subeditor.visualEditor) {
						console.log("Create VisualEditor for ", input);
						$input.attr('type', 'textarea');
						$input.addClass('toolbarOnTop');
						if ( $.fn.applyVisualEditor ) subeditor.visualEditor = $input.applyVisualEditor();
						else $(document).on('VEForAllLoaded', function(e) { 
							subeditor.visualEditor = $input.applyVisualEditor(); 
						});
						//$('.ve-ui-surface-visual').addClass('form-control');
					}
					console.log("Original field value: ", subeditor.input.value);
				}
				//BUG: Text is hidden until user clicks in textarea. Does not save value in original text field.
				if (subeditor.options && subeditor.options.wikieditor === 'codemirror') {

					if (!subeditor.codeMirror) {
						console.log("Create CodeMirror for ", input);
						$input.attr('type', 'textarea');
						$input.attr('data-ve-loaded', true);

						//from https://phabricator.wikimedia.org/diffusion/ECMI/browse/master/resources/ext.CodeMirror.js$210
						var cmOptions = {
							mwConfig: mw.config.get('extCodeMirrorConfig'),
							// styleActiveLine: true, // disabled since Bug: T162204, maybe should be optional
							lineWrapping: true,
							lineNumbers: true,
							readOnly: false,
							// select mediawiki as text input mode
							mode: 'text/mediawiki',
							extraKeys: {
								Tab: false,
								'Shift-Tab': false,
								// T174514: Move the cursor at the beginning/end of the current wrapped line
								Home: 'goLineLeft',
								End: 'goLineRight'
							},
							inputStyle: 'contenteditable',
							spellcheck: true,
							viewportMargin: Infinity
						};
						var codeMirror = CodeMirror.fromTextArea(input, cmOptions);
						var $codeMirror = $(codeMirror.getWrapperElement());

						//codeMirror.scrollTo( null, $input.scrollTop(), );
						$(codeMirror.getInputField())
							// T259347: Use accesskey of the original textbox
							.attr('accesskey', $input.attr('accesskey'))
							// T194102: UniversalLanguageSelector integration is buggy, disabling it completely
							.addClass('noime');

						codeMirror.refresh();
						//mw.hook('ext.CodeMirror.switch').fire(true, $codeMirror);
						subeditor.codeMirror = codeMirror;
					}
					else {
						subeditor.codeMirror.save(); //update original input field
					}
					//$('.CodeMirror-scroll').each(function() {console.log(this); this.dispatchEvent(new Event('click')) });
					//$('.CodeMirror-wrap').each(function() {this.dispatchEvent(new Event('click')) });
				}

				if (subeditor.options && subeditor.options.wikieditor === 'jsoneditors') {
					if (!subeditor.jsoneditors) {
						console.log("Create JSONEditors for ", input);
						$input.hide();
						var $parent = $input.parent();
						$parent.append('<div class="jsoneditors" style="height: 500px; resize: vertical; overflow: auto;"></div>');
						var container = $parent.find(".jsoneditors")[0];
						var options = {
							mode: 'code',
							modes: ['code', 'form', 'text', 'tree', 'view', 'preview'], // allowed modes
							onChangeText: (function(jsonString){
								//input.value = jsonString;
								this.value = jsonString;
								this.change();
							}).bind(subeditor) //arrow function binding to loop var subeditor does not work 
						}
						subeditor.jsoneditors = new JSONEditors(container, options);
						subeditor.jsoneditors.set(JSON.parse(subeditor.input.value));
					}
				}
			}

			//fetch labels
			if (label_requests.length) mwjson.api.getLabels(label_requests).then((label_dict) => {
				for (const labeled_input of labeled_inputs) {
					console.log("Set label " + label_dict[labeled_input.value_id] + " for " + labeled_input.input.value);
					labeled_input.input.value_id = labeled_input.value_id;
					labeled_input.input.value_label = label_dict[labeled_input.value_id];
					labeled_input.input.value = labeled_input.input.value_label;
				}
			});

			this.flags["change-after-load"] = false;

			if (this.config.onchange) this.config.onchange(this.jsoneditor.getValue());

			if (this.data_jsoneditors) {
				var jsondata = this.jsoneditor.getValue();
				jsondata = mwjson.util.mergeDeep({"@context": this.jsonschema.getContext()}, jsondata)
				console.log("add context", this.jsonschema.getContext());
				this.data_jsoneditors.set(jsondata);
			}
		});

		var resetAutocompleteEditors = () => {
			var all_editors = [];
			for (var subeditor_path of Object.keys(this.jsoneditor.editors)) {
				var e = this.jsoneditor.editors[subeditor_path]
				if (e) {
					all_editors.push(e)
					if (e.editors) all_editors = all_editors.concat(e.editors); // actual multiple editors due to oneOf schema
				}
			}

			for (var subeditor of all_editors) {
				if (subeditor.format === 'autocomplete') {
					subeditor.input.value_label = null;
					subeditor.input.value_id = null;
					//subeditor.change();
				}
			}
		}

		// listen for array changes
		this.jsoneditor.on('moveRow', editor => {
			// since the input elements stay in place but the editors are rewired
			// we need to reset the input elements 
			resetAutocompleteEditors();
		});
		this.jsoneditor.on('deleteRow', value => {
			// since the input elements stay in place but the editors are rewired
			// we need to reset the input elements 
			resetAutocompleteEditors()
		});

		// problem: is called both when row is added or created
		// removing ignored properties conflicts with defaultProperties
		this.jsoneditor.on('addRow', editor => {
			//console.log('addRow', editor);
			let ignored_properties = [];
			if (editor.schema?.options?.copy_ignore) ignored_properties = ignored_properties.concat(editor.schema?.options?.copy_ignore);
			if (editor.parent?.schema?.options?.array_copy_ignore) ignored_properties = ignored_properties.concat(editor.parent?.schema?.options?.array_copy_ignore);
			let value = mwjson.util.deepCopy(editor.getValue());
			let changed = false;
			for (let p of ignored_properties) {
				let keep = (editor.schema?.required?.includes(p) || editor.schema?.defaultProperties?.includes(p))
				let default_value = null
				if (Object.hasOwn(value, p)) {
					if (value[p] && typeof value[p] === 'string') default_value = "";
					//if (value[p]) keep ? value[p] = default_value : delete value[p];
					if (value[p] && keep) { console.log("default", default_value); value[p] = default_value; }
					if (value[p] && !keep) { console.log("delete"); delete value[p]; }
					console.log("Remove", p, keep, "=>", value);
					changed = true
				}
				//value[p] = default_value
			}
			console.log(JSON.stringify(value));
			if (changed) editor.setValue(value);
		});

		this.jsoneditor.on('copyRow', value => {
			// not implemented (yet) by json-editor
			//console.log('copyRow', value);
		});
	}

	updateSubjectId() {
		var jsondata = this.jsoneditor.getValue();
		var subject_id = this.config.getSubjectId({jsondata: jsondata, editor: this});
		if (subject_id != this.config.target) console.log("Set subject id to ", subject_id);
		this.config.target_namespace = subject_id.split(":")[0];
		this.config.target = subject_id;
	}

	// adds suppport for backend supplied variables like {{_global_index_}}
	async formatDynamicTemplate(jseditor_editor, watched_values) {
		
		if (jseditor_editor.schema.dynamic_template.includes("_current_user_")) {
			let user_page_or_item = jseditor_editor.jsoneditor.mwjson_editor.config.user_id;
			let query_url = mw.config.get("wgScriptPath") + `/api.php?action=ask&format=json&query=[[User:${user_page_or_item}]]`;
			let result = await (await fetch(query_url)).json();
			if (result?.query?.results) {
				// the result page title respects redirects,
				// e.g. Item:... is returned if User:... redirects to Item:...
				for (let page_title in result.query.results) user_page_or_item = page_title;
			}
			watched_values["_current_user_"] = user_page_or_item;
		}
		watched_values["_current_subject_"] = jseditor_editor.jsoneditor.mwjson_editor.config.target;
		var index = jseditor_editor.parent?.key;
		watched_values["i1"] = index ? index * 1 + 1 : 0;
		watched_values["_array_index_"] = index ? index * 1 + 1 : 0;
		watched_values["i01"] = index ? index * 1 + 1 : 0;
		//var postqueries = [];
		//todo: use jseditor_editor.formname // root[<key>]
		let set_value = this.config.data;
		let set = true;
		if (this.config.data) {
			let path = jseditor_editor.path.split('.'); // e.g. "root.samples.1.id"
			path.shift(); //remove first element ('root')
			for (let e of path) {
				//test for integer, see https://stackoverflow.com/questions/10834796/validate-that-a-string-is-a-positive-integer
				if (0 === e % (!isNaN(parseFloat(e)) && 0 < ~~e)) set_value = set_value[parseInt(e, 10)]; // array index
				else set_value = set_value[e]; // object key
				if (!set_value || set_value === "") {
					set = false;
					break; // path does not exist or is empty
				}
			}
		}
		else set = false;
		//let set = (this.config.data && this.config.data[jseditor_editor.key] && this.config.data[jseditor_editor.key] !== "")
		console.log("Set ", jseditor_editor.key, " ", jseditor_editor.formname, " ", set);
		let override = jseditor_editor.schema?.options?.dynamic_template?.override;
		let override_empty = jseditor_editor.schema?.options?.dynamic_template?.override_empty || false;
		// Todo: set override_empty true if not hidden and not read-only
		if (override_empty) set = (jseditor_editor.value && jseditor_editor.value !== "")

		if (!set || override === true) {
			//retriev the existing property value with the highest value for the unique number
			var context = {
				property: "HasId",
				number_pattern: "0000",
				increment: 1,
				debug: true,

			};
			if (!jseditor_editor.schema?.dynamic_template) return;
			if (jseditor_editor.schema?.options?.data_maps) {
				for (const map of jseditor_editor.schema.options.data_maps) {
					let query_url = Handlebars.compile(map.query)(watched_values);
					query_url = mw.config.get("wgScriptPath") + `/api.php?action=ask&format=json&query=` + query_url;
					let result = await (await fetch(query_url)).json();

					var value = mwjson.extData.getValue(result, map.source_path, "jsonpath");
					if (map.template) value = Handlebars.compile(map.template)(value);
					if (map.storage_path) watched_values[map.storage_path] = value; //ToDo: support nested
					if (map.target_path) {
						var target_editor = Handlebars.compile(map.target_path)(watched_values);
						//for (const key in jseditor_editor.watched_values) target_editor = target_editor.replace('$(' + key + ')', jseditor_editor.watched[key]);
						if (jseditor_editor.jsoneditor.editors[target_editor]) {
							jseditor_editor.jsoneditor.editors[target_editor].setValue(value);
						}
					}
				}
			}
			let fetch_global_index = false;
			if (jseditor_editor.schema.dynamic_template.includes("{{{_global_index_}}}")) {
				fetch_global_index = true;
				context.value = Handlebars.compile(jseditor_editor.schema.dynamic_template.replace("{{{_global_index_}}}", "%_global_index_%"))(watched_values);
			}
			else if (jseditor_editor.schema.dynamic_template.includes("{{_global_index_}}")) {
				fetch_global_index = true;
				context.value = Handlebars.compile(jseditor_editor.schema.dynamic_template.replace("{{_global_index_}}", "%_global_index_%"))(watched_values);
			}
			if (fetch_global_index) {
				var query = mw.config.get("wgScriptPath") + `/api.php?action=ask&query=[[${context.property}::~${context.value.replace("%_global_index_%", "*")}]]|?${context.property}|sort=${context.property}|order=desc|limit=1&format=json`;
				//var receiveHighestExistingValuesQuery = $.ajax({url : query, dataType: "json", cache: false,
				//	success : (data) => {
				//let query1 = mw.config.get("wgScriptPath") + `/api.php?action=ask&query=[[User:${watched_values["_current_user_"]}]]|?HasAbbreviation=abbreviation&format=json`;
				//let data1 = await (await fetch(query1)).json()
				//console.log(data1);
				let data = await (await fetch(query)).json();
				var number_start = context.increment;
				context.unique_number_string = "" + number_start;
				for (var key in data.query.results) {

					if (data.query.results[key].printouts[context.property][0] !== undefined) {
						context.highestExistingValue = data.query.results[key].printouts[context.property][0];
						if (context.debug) console.log("highestExistingValue:" + context.highestExistingValue);
						var regex = new RegExp(context.value.replace("%_global_index_%", "([0-9]*)"), "g");
						context.unique_number_string = regex.exec(context.highestExistingValue)[1];
						context.unique_number_string = "" + (parseInt(context.unique_number_string) + context.increment);
					}
				}
				context.unique_number_string = (context.number_pattern + context.unique_number_string).substr(-context.number_pattern.length);
				watched_values["_global_index_"] = context.unique_number_string
				//context.value = context.value.replace("*", context.unique_number_string);
			}
			context.value = Handlebars.compile(jseditor_editor.schema.dynamic_template)(watched_values);
			//$(context.field).val(context.value);
			console.log("Set value", context)
			set_value = context.value;
			jseditor_editor.setValue(set_value)
		}
		else {
			if (set_value && set_value !== "") jseditor_editor.setValue(set_value);
		}
		return set_value; // return the value for template: dynamic_template
	}

	createUI() {
		if (this.config.submit_enabled && (!this.config.popup || this.config.mode === 'query')) {
			var btn_label = mw.message("mwjson-editor-submit-save").text();
			if (this.config.mode === 'query') btn_label = mw.message("mwjson-editor-submit-query").text();
			const btn_id = this.config.id + "_save-form";
			$(this.container).append($("<button type='Button' class='btn btn-primary btn-block' id='" + btn_id + "'>" + btn_label + "</button>"));
			$("#" + btn_id).click(() => {
				console.log("Query");
				this._onsubmit(this.jsoneditor.getValue());
			});
		}

		if (this.jsonschema.data_source_maps.length && this.config.mode === 'default') {
			//console.log(this.jsonschema.data_source_maps);
			for (const [index, data_source_map] of this.jsonschema.data_source_maps.entries()) {
				if (!data_source_map.label) data_source_map.label = data_source_map.source.substring(0, 20) + "...";
				var btn_label = mw.message("mwjson-editor-fetch-external-data", data_source_map.label).text();
				if (data_source_map.required) {
					var required_prop_names = "";
					for (const required_prop of data_source_map.required) required_prop_names += this.jsonschema.getPropertyDefinition(required_prop).title + ", ";
					required_prop_names = required_prop_names.slice(0,-2);
					btn_label += " (" + mw.message("mwjson-editor-fetch-external-data-requires", required_prop_names).text() + ")";
				}
				$(this.container).append($("<button type='Button' class='btn btn-primary btn-block' id='fetch-external-data-" + index + "'>" + btn_label + "</button>"));
				this.jsoneditor.on('change', () => {
					var enabled = true;
					var jsondata = this.jsoneditor.getValue();
					for (const required_prop of data_source_map.required) if (!jsondata[required_prop]) enabled = false;
					$("#fetch-external-data-" + index).prop('disabled', !enabled);
				});
				$("#fetch-external-data-" + index).click(() => {
					$("#fetch-external-data-" + index).text(btn_label + ": Running...").css('background-color', 'orange');
					mwjson.extData.fetchData([data_source_map], this.jsoneditor.getValue()).then((jsondata) => {
						$("#fetch-external-data-" + index).text(btn_label + ": Done.").css('background-color', 'green');
						this.jsoneditor.setValue(jsondata);
					});
				});
			}
		}

		if (this.config.schema_editor) {
			var options = {
				mode: 'code',
				modes: ['code', 'form', 'text', 'tree', 'view', 'preview'], // allowed modes
			}
			var container = $("#" + this.config.schema_editor.container_id);
			container.addClass('mwjson-code-container')
			var editor_container = $('<div class="mwjson-code-editor-container"></div>');
			container.append(editor_container);
			this.schema_jsoneditors = new JSONEditors(editor_container[0], options);
			this.schema_jsoneditors.set(this.config.schema);
			var btn_label = "Update";
			const btn_id = this.config.id + "_load-schema";
			container.append($("<button type='Button' class='btn btn-primary btn-block' id='" + btn_id + "'>" + btn_label + "</button>"));
			$("#" + btn_id).click(() => {
				this.setSchema({schema: this.schema_jsoneditors.get()});
			});
		}
		if (this.config.data_editor) {
			var options = {
				mode: 'code',
				modes: ['code', 'form', 'text', 'tree', 'view', 'preview'], // allowed modes
				onChangeText: (jsonString) => {
					var jsondata = JSON.parse(jsonString);
					if (jsondata['@context']) delete jsondata['@context'];
					this.jsoneditor.setValue(jsondata);
				}
			}
			var container = $("#" + this.config.data_editor.container_id);
			container.addClass('mwjson-code-container')
			var editor_container = $('<div class="mwjson-code-editor-container"></div>');
			container.append(editor_container);
			this.data_jsoneditors = new JSONEditors(editor_container[0], options);
			//subeditor.jsoneditors.set(JSON.parse(subeditor.input.value));
			var btn_label = "Download";
			const btn_id = this.config.id + "_download_jsonld";
			container.append($("<a type='Button' class='btn btn-primary btn-block' id='" + btn_id + "' style='color:white'>" + btn_label + "</a>"));
			$("#" + btn_id).click(() => {
				//var jsondata = this.jsoneditor.getValue();
				//jsondata = mwjson.util.mergeDeep({"@context": this.jsonschema.getContext()}, jsondata)
				//console.log("add context", this.jsonschema.getContext());
				var jsondata = this.data_jsoneditors.get();
				mwjson.util.downloadTextAsFile("metadata.jsonld", JSON.stringify(jsondata, null, 4));
			});
		}
	}

	getSyntaxErrors() {
		const promise = new Promise((resolve, reject) => {
		var errors = []
		var validation_promises = [];

		var all_editors = [];
		for (var subeditor_path of Object.keys(this.jsoneditor.editors)) {
			var e = this.jsoneditor.editors[subeditor_path]
			if (e) {
				all_editors.push(e)
				if (e.editors) all_editors = all_editors.concat(e.editors); // actual multiple editors due to oneOf schema
			}
		}

		for (var subeditor of all_editors) {
			if(subeditor.ace_editor_instance) {
				for (var error of subeditor.ace_editor_instance.getSession().getAnnotations()) {
					if (error.type == 'error') {
						error.editor_path = subeditor.path;
						error.editor_label = subeditor.label.innerText;
						errors.push(error)
					}
				}
			}
				if (subeditor.jsoneditors) {
					validation_promises.push(subeditor.jsoneditors.validate())
		}
			}
			if (validation_promises.length) {
				Promise.allSettled(validation_promises).then((results) => {
					for (const result of results) {
						for (var error of result.value) {
							if (error.type == 'error') {
								error.editor_path = subeditor.path;
								error.editor_label = subeditor.label.innerText;
								errors.push(error)
							}
						}
					}
					resolve(errors);
				});
			}
			else {
				resolve(errors);
			}
		});
		return promise;
	}

	setData(params) {
		this.jsoneditor.setValue(params.jsondata);
	}

	getData() {
		return this.jsoneditor.getValue();
	}

	//sets a new jsonschema and reloads the editor to apply changes
	setSchema(params) {
		this.jsoneditor.destroy();
		this.config.schema = params.schema;
		this.jsonschema = new mwjson.schema({jsonschema: this.config.schema, config: {mode: this.config.mode, lang: this.config.lang}, debug: true});
		this.jsonschema.bundle()
			.then(() => this.jsonschema.preprocess())
			.then(() => {
				console.log("reload editor");
				this.createEditor();
			})
			.catch((err) => {
				console.error(err);
			});
	}

	_onsubmit(json, meta) {
		document.activeElement.blur(); //ensure input is defocused to update final jsondata
		const promise = new Promise((resolve, reject) => {
			this.getSyntaxErrors().then((errors) => {
				const validation_errors = this.jsoneditor.validate();
				if(errors.length || validation_errors.length) {
					let msg = mw.message("mwjson-editor-fields-contain-error").text();
					if (this.config.allow_submit_with_errors) {
						msg += ". " + mw.message("mwjson-editor-save-anyway").text();
						OO.ui.confirm( msg ).done( ( confirmed ) => {
							if ( confirmed ) {
								if (this.config.mode !== 'query') mw.notify(mw.message("mwjson-editor-do-not-close-window").text(), { title: mw.message("mwjson-editor-saving").text() + "...", type: 'warn'});
								const submit_promise = this.config.onsubmit(json, meta);
									if (submit_promise) submit_promise.then(() => {
										resolve();
								if (this.config.mode !== 'query') mw.notify(mw.message("mwjson-editor-saved").text(), { type: 'success'});
									}).catch();
									else {
										resolve();
										if (this.config.mode !== 'query') mw.notify(mw.message("mwjson-editor-saved").text(), { type: 'success'});
									}
							} else {
								reject();
							}
						} );
					}
					else {
						msg += ". " + mw.message("mwjson-editor-fix-all-errors").text();
						OO.ui.alert( msg ).done( () => {
							reject();
						} );
					}
			}
			else {
				if (this.config.mode !== 'query') mw.notify(mw.message("mwjson-editor-do-not-close-window").text(), { title: mw.message("mwjson-editor-saving").text() + "...", type: 'warn'});
				const submit_promise = this.config.onsubmit(json, meta);
					console.log(submit_promise);
					if (submit_promise) submit_promise.then(() => {
						resolve();
						if (this.config.mode !== 'query') mw.notify(mw.message("mwjson-editor-saved").text(), { type: 'success'});
					}).catch();
					else {
						resolve();
				if (this.config.mode !== 'query') mw.notify(mw.message("mwjson-editor-saved").text(), { type: 'success'});
			}
				}
		});
		});
		return promise;
	}

	onsubmit(json, meta) {
		if (this.config.mode === 'default') return this.onsubmitPage(json, meta);
		else if (this.config.mode === 'query') return this.onsubmitQuery(json, meta);
	}

	onsubmitPage(json, meta) {
		meta = meta || {}
		meta.comment = meta.comment || "Edited with JsonEditor";
		const promise = new Promise((resolve, reject) => {
			if (!this.config.target) {
				this.config.target = "";
				if (this.config.target_namespace !== "") this.config.target += this.config.target_namespace + ":";
				this.config.target += mwjson.util.OslId(json.uuid);
			}
			console.log("Save form");
			var url = window.location.href.replace(/\?.*/, '');
			url += '?target=' + encodeURIComponent(this.config.target);
			url += '&data=' + encodeURIComponent(mwjson.util.objectToCompressedBase64(json));

			console.log(JSON.stringify(json));
			mwjson.api.getPage(this.config.target).then((page) => {
				if (page.content_model[this.config.target_slot] === 'wikitext') {
					page.content = mwjson.editor.mwjson.parser.data2template(json)
					//add edit link with base64 encode data
					//page.content = "<noinclude>[" + url + " Edit Template]</noinclude>\n<br\>" + page.content;
					page.changed = true;
					//console.log(page.content);
					var wikiJson = mwjson.editor.mwjson.parser.schemaJson2WikiJson(json)
					page.dict = wikiJson;
					mwjson.parser.updateContent(page);
					console.log(wikiJson);
					console.log(page.content);
				}
				if (page.content_model[this.config.target_slot] === 'json') {
					page.slots[this.config.target_slot] = json;
					page.slots_changed[this.config.target_slot] = true;
				}
				mwjson.api.updatePage(page, meta).then(() => {
					resolve();
					window.location.href = mw.util.getUrl(page.title);
				});
			}).catch();
		});
		return promise;
		//mwjson.parser.parsePage(page)
		//console.log(page.dict);
		/*return;
		console.log(this.targetPage.data);
		if (Array.isArray(this.targetPage.data)) {
			this.targetPage.data.forEach((template, index) => {
				Object.assign(template, this.jsoneditor.getValue()[index]);
				wikitext = mwjson.parser.data2template(template);
				template._token.clear();
				template._token.push(wikitext);
			});
		}
		else {
			var template = this.targetPage.data;
			Object.assign(template, this.jsoneditor.getValue());
			wikitext = mwjson.parser.data2template(template);
			template._token.clear();
			template._token.push(wikitext);
		}
		this.targetPage.content = this.targetPage.parsedContent.toString();
		console.log(this.targetPage.content);
		var params = {
			action: 'edit',
			title: this.targetPage.name,
			text: this.targetPage.content,
			format: 'json'
		};
		this.api.postWithToken('csrf', params).done(function (data) {
			console.log('Saved!');
		});*/
	}

	onsubmitQuery(json, meta) {
		const $result_container = $('#' + this.config.result_container_id);
		$result_container.html("");
		var wikitext = this.jsonschema.getSemanticQuery({jsondata: json}).wikitext;
		console.log("wikitext", wikitext);
		//var renderUrl = mw.config.get("wgScriptPath") + '/api.php?action=parse&format=json&text=';
		//renderUrl += encodeURIComponent(wikitext);
		new Promise(resolve => {
			//console.log("Render-URL: " + renderUrl);
			//fetch(renderUrl)
				//.then(response => response.json())
			mwjson.api.parseWikiText({text: wikitext, display_mode: "iframe", container: $result_container[0]})
				.then(result => {
					//console.log("Parsed: " + data.parse.text);
					//$result_container.html($(result.html));
					$result_container.find("iframe").contents().find("a").attr("target", "_blank"); //make all links open in new tab - does not work on dynamic content
					//mwjson.editor.initDataTables(); 
				});
		});
	}

	static init() {

		const mw_modules = [
			'ext.mwjson.editor.ace',
			'ext.codeEditor.ace', //loading ace.min.js leads to styling issues (css conflict with codeEditor?)
			'ext.veforall.main',
			'ext.geshi.visualEditor',
			'ext.CodeMirror.lib',
			'ext.CodeMirror.mode.mediawiki',
			'ext.CodeMirror',
			//'ext.wikiEditor',
			//'ext.srf.datatables.bootstrap',
			//'smw.tableprinter.datatable', 'ext.smw.table.styles',
			//'ext.srf', 'ext.srf.api', 'ext.srf.util', 'ext.srf.widgets',
			//'ext.jquery.async','ext.jquery.atwho','ext.jquery.caret','ext.jquery.jStorage','ext.jquery.md5',
			//'ext.libs.tippy',
			//'ext.smw.api',
			//'ext.smw.data','ext.smw.dataItem','ext.smw.dataValue','ext.smw.purge','ext.smw.query','ext.smw.suggester','ext.smw.tooltips',
			//'ext.smw.suggester.textInput', 'smw.entityexaminer','smw.factbox','smw.tippy'
		];

		const deferred = $.Deferred();
		if (!('ready' in mwjson.editor) || !mwjson.editor.ready) {
			//mw.loader.load('https://maxcdn.bootstrapcdn.com/bootstrap/4.0.0/css/bootstrap.min.css', 'text/css');
			//mw.loader.load('https://cdn.jsdelivr.net/npm/spectre.css@latest/dist/spectre-icons.min.css', 'text/css');
			mwjson.parser.init();
			$.when(
				//$.getScript("https://cdn.jsdelivr.net/npm/@json-editor/json-editor@latest/dist/jsoneditor.js"),
				//$.getScript("https://unpkg.com/imask"),
				//$.getScript("https://cdn.jsdelivr.net/npm/ace-builds@latest/src-noconflict/ace.min.js"),
				mw.loader.using(mw_modules), 
				//mw.loader.using('ext.wikiEditor'),
				//$.getScript(mw.config.get("wgScriptPath") + "/extensions/MwJson/modules/ext.MwJson.editor/json-schema-ref-parser.js"),
				$.Deferred(function (deferred) {
					$(deferred.resolve);
				})
			).done(function () {

				for (var key of Object.keys(JSONEditor.defaults.languages.en)) {
					//replace with mediawiki i18n
					var msg = mw.message("json-editor-" + key);
					if (msg.exists())
						JSONEditor.defaults.languages.en[key] = msg.text().replaceAll('((', '{{').replaceAll('))', '}}');
					else console.warn("i18n message not defined: " + "'json-editor-" + key + "'");
				}
				mwjson.editor.setCallbacks();
				mwjson.editor.setDefaultOptions();
				//console.log("JsonEditor initialized");
				deferred.resolve();
			});
		}
		else deferred.resolve(); //resolve immediately
		return deferred.promise();
	}

	static setDefaultOptions() {
		window.JSONEditor.defaults.options.template = 'handlebars';
		window.JSONEditor.defaults.options.autocomplete = {
			"search": "search_smw",
			"getResultValue": "getResultValue_smw",
			"renderResult": "renderResult_smw",
			"onSubmit": "onSubmit_smw",
			"autoSelect": "true",
			"debounceTime": 200
		};
		window.JSONEditor.defaults.options.ace = {
			//"theme": "ace/theme/vibrant_ink",
			"tabSize": 4,
			"useSoftTabs": true,
			"wrap": true,
			"useWorker": true
		};
		ace.config.set("basePath", mw.config.get("wgScriptPath") + "/extensions/MwJson/modules/ext.MwJson.editor.ace");
		ace.config.set("workerPath", mw.config.get("wgScriptPath") + "/extensions/MwJson/modules/ext.MwJson.editor.ace");
		ace.config.setModuleUrl('ace/mode/json_worker', mw.config.get("wgScriptPath") + "/extensions/MwJson/modules/ext.MwJson.editor.ace/worker-json.js");
		// see https://github.com/json-editor/json-editor/blob/master/README_ADDON.md#upload
		// ToDo: add translations
		window.JSONEditor.defaults.options.upload = {
			title: 	"Browse", // string, Title of the Browse button, default: "Browse"
			auto_upload: true, // boolean, Trigger file upload button automatically, default: false
			allow_reupload: true, // boolean, Allow reupload of file (overrides the readonly state), default: false
			hide_input: false, // boolean, Hide the Browse button and name display (Only works if 'enable_drag_drop' is true), default: false
			enable_drag_drop: true, // boolean, Enable Drag&Drop uploading., default: false
			drop_zone_top: false, // boolean, Position of dropzone. true=before button input, false=after button input, default: false
			drop_zone_text: "Drag & Drop", // string, Text displayed in dropzone box, default: "Drag & Drop file here"
			//alt_drop_zone: "", // string, Alternate DropZone DOM Selector (Can be created inside another property) 	
			//mime_type: false, // string/array, If set, restrict upload to mime type(s) 	
			max_upload_size: 0, // integer, Maximum file size allowed. 0 = no limit, default: 0
			upload_handler: "fileUpload", // function, Callback function for handling uploads to server 	
			icon: "upload", // undocumented, but missing if not set
		};
	}

	static setCallbacks() {
		window.JSONEditor.defaults.callbacks = {
			'now': (jseditor_editor, e) => {
				var t = new Date()
				t.setDate(t.getDate())
				return t.toISOString().split('T')[0] + 'T00:00'
			},
			"template": {
				"dynamic_template": (jseditor_editor, watched_values) => {
					return jseditor_editor.jsoneditor.mwjson_editor.formatDynamicTemplate(jseditor_editor, watched_values);
				},
			},
			"autocomplete": {
				// This is callback functions for the "autocomplete" editor
				// In the schema you refer to the callback function by key
				// Note: 1st parameter in callback is ALWAYS a reference to the current editor.
				// So you need to add a variable to the callback to hold this (like the
				// "jseditor_editor" variable in the examples below.)

				// Search function can return a promise
				// which resolves with an array of
				// results. In this case we're using
				// the SMW query API.
				search_smw: (jseditor_editor, input) => {
					if (jseditor_editor.watched_values) console.log("Watched: " + jseditor_editor.watched_values);
					var query = mwjson.schema.getAutocompleteQuery(jseditor_editor.schema, input);
					
					for (const key in jseditor_editor.watched_values) {
						if (jseditor_editor.watched[key]) {
							var subeditor = jseditor_editor.jsoneditor.editors[jseditor_editor.watched[key]];
							if (subeditor) {
								//jseditor_editor.jsoneditor.editors[jseditor_editor.watched[key]].change(); //force value update
								//onChange is not called yet => explicite update autocomplete fields
								if (subeditor.format === 'autocomplete' && subeditor.input.value_id && subeditor.input.value_label) {
									subeditor.input.value = subeditor.input.value_label;
									subeditor.value = subeditor.input.value_id; //will be applied on the next .getValue() call
									if (subeditor.is_dirty) subeditor.change(); //resets aborted user input
									subeditor.is_dirty = false;
								}
							}
							query = query.replace('{{$(' + key + ')}}', '{{' + jseditor_editor.watched[key].replace("root.","") + '}}');
						}
						if (jseditor_editor.watched_values[key] === undefined) query = query.replace('$(' + key + ')', encodeURIComponent('+'));
						query = query.replace('$(' + key + ')', jseditor_editor.watched_values[key]);
					}

					//create a copy here since we add addition properties
					var jsondata = mwjson.util.deepCopy(jseditor_editor.jsoneditor.getValue());
					jsondata['_user_input'] = input; 
					jsondata['_user_input_lowercase'] = input.toLowerCase(); 
					jsondata['_user_input_normalized'] = mwjson.util.normalizeString(input); 
					jsondata['_user_lang'] = jseditor_editor.jsoneditor.options.user_language; 
					var template = Handlebars.compile(query);
					query = template(jsondata);
					var result_property = mwjson.schema.getAutocompleteResultProperty(jseditor_editor.schema);
					console.log("Search with schema: " + query);
					var url = mw.config.get("wgScriptPath") + `/api.php?action=ask&query=${query}`;
					if (!url.includes("|limit=")) url += "|limit=100";
					url += "&format=json";
					//replace params
					console.log("URL: " + url);

					return new Promise(resolve => {
						//min input len = 0
						if (input.length < 0) {
							return resolve([]);
						}
						console.log("Query-URL: " + url);
						fetch(url)
							.then(response => response.json())
							.then(data => {
								//convert result dict to list/array
								var resultList = Object.values(data.query.results); //use subjects as results
								if (result_property) { //use objects as results
									resultList = [];
									Object.values(data.query.results).forEach(result => {
										resultList = resultList.concat(result.printouts[result_property])
									});
									resultList = [...new Set(resultList)]; //remove duplicates
								}
								//filter list
								resultList = resultList.filter(result => {
									return mwjson.util.normalizeString(JSON.stringify(result)).includes(mwjson.util.normalizeString(input)); //slow but generic
								});

								resolve(resultList);
							});
					});
				},
				renderResult_smw: (jseditor_editor, result, props) => {
					if (!result.printouts) return "";
					// normalize multilanguage printouts (e. g. description)
					result = mwjson.util.normalizeSmwMultilangResult(result, jseditor_editor.jsoneditor.options.user_language);

					var previewTemplate = mwjson.util.deepCopy(mwjson.schema.getAutocompletePreviewTemplate(jseditor_editor.schema)); //use custom value
					if (previewTemplate.type.shift() === 'handlebars') {
						if (previewTemplate.type[0] === 'wikitext') previewTemplate.value = previewTemplate.value.replaceAll("\\{", "&#123;").replaceAll("\\}", "&#125;"); //escape curly-brackets with html entities. ToDo: Do this once for the whole schema
						var template = Handlebars.compile(previewTemplate.value);
						previewTemplate.value = template({ result: result });
						if (previewTemplate.type[0] === 'wikitext') previewTemplate.value = previewTemplate.value.replaceAll("&#123;", "{").replaceAll("&#125;", "}");
					}

					if (previewTemplate.type.shift() === 'wikitext') {
					var renderUrl = mw.config.get("wgScriptPath") + '/api.php?action=parse&format=json&text=';
						renderUrl += encodeURIComponent(previewTemplate.value);
						previewTemplate.value = "";
					new Promise(resolve => {
						fetch(renderUrl)
							.then(response => response.json())
							.then(data => {
								//console.log("Parsed: " + data.parse.text);
								//console.log("ID = " + props.id);
								$("#" + props.id).append($(data.parse.text['*']));
								//resolve(data.parse.text);
							});
					});
					}
					return `
					<li ${props}>${previewTemplate.value}
					</li>`;
				},

				// SMW returns a format like this:
				//{"query":
				//   "results":
				//       {"PAGE":
				//           {"printouts":[],"fulltext":"PAGE","fullurl":"https://.../wiki/PAGE","namespace":0,"exists":"1","displaytitle":""}
				// ...
				// Display the label...
				getResultValue_smw: (jseditor_editor, result) => {
					var label = result.fulltext;
					if (result.displaytitle && result.displaytitle !== "") label = result.displaytitle;
					var labelTemplate = mwjson.util.deepCopy(mwjson.schema.getAutocompleteLabelTemplate(jseditor_editor.schema)); //use custom value
					if (labelTemplate.type.shift() === 'handlebars') {
						label = Handlebars.compile(labelTemplate.value)({ result: result });
					}
					jseditor_editor.input.value_label = label;
					return label;
				},
				//... but store the fulltext / id
				onSubmit_smw: (jseditor_editor, result) => {
					console.log("Selected: " + result.displaytitle + " / " + result.fulltext);
					var result_value = result.fulltext;
					var storeTemplate = mwjson.util.deepCopy(mwjson.schema.getAutocompleteStoreTemplate(jseditor_editor.schema)); //use custom value
					if (storeTemplate && storeTemplate.type.shift() === 'handlebars') {
						result_value = Handlebars.compile(storeTemplate.value)({ result: result });
					}
					jseditor_editor.value = result_value;
					jseditor_editor.input.value_id = result_value;
					jseditor_editor.onChange(true);
					if (jseditor_editor.schema.options.autocomplete.field_maps) {
						for (const map of jseditor_editor.schema.options.autocomplete.field_maps) {
							var value = mwjson.extData.getValue({result: result}, map.source_path, "jsonpath");
							if (map.template) value = Handlebars.compile(map.template)(value);
							var target_editor = map.target_path;
							for (const key in jseditor_editor.watched_values) target_editor = target_editor.replace('$(' + key + ')', jseditor_editor.watched[key]);
							if (jseditor_editor.jsoneditor.editors[target_editor]) {
								jseditor_editor.jsoneditor.editors[target_editor].setValue(value);
							}
						}
					}
				},
			},
			upload: {
				fileUpload: (jseditor, type, file, cbs) => {
					var mwjson_editor = jseditor.jsoneditor.mwjson_editor; //get the owning mwjson editor class instance
					const label = file.name;
					var target = mwjson.util.OswId() + "." + file.name.split('.').pop();
					if (jseditor.value && jseditor.value !== "") target = jseditor.value; // reupload
					if (jseditor.key === "file" && mwjson_editor.jsonschema.subschemas_uuids.includes("11a53cdf-bdc2-4524-bf8a-c435cbf65d9d")) { //uuid of Category:WikiFile
						mwjson_editor.config.target_namespace = "File";
						if (mwjson_editor.config.target && mwjson_editor.config.target !== "") {
							// the file page already exists
							target = mwjson_editor.config.target.replace(mwjson_editor.config.target_namespace + ":", "");
							//console.log("set target to config.target: ", target);
						}
						else {
							// this file page is not yet created => set the page name
							mwjson_editor.config.target = mwjson_editor.config.target_namespace + ":" + target;
							//console.log("set config.target to target: ", mwjson_editor.config.target);
						}
						// set label from file label if not set yet
						if (jseditor.jsoneditor.editors["root.label.0.text"]) {
							if (!jseditor.jsoneditor.editors["root.label.0.text"].value || jseditor.jsoneditor.editors["root.label.0.text"].value === "") {
								jseditor.jsoneditor.editors["root.label.0.text"].setValue(label);
								jseditor.jsoneditor.editors["root.label.0.text"].change();
							}
						}
					}

					Object.defineProperty(file, 'name', {writable: true, value: target}); //name is readonly, so file.name = target does not work
					mwjson.api.getFilePage(target).done((page) => {
						//console.log("File does exists");
						page.file = file;
						page.file.contentBlob = file;
						page.file.changed = true;
						mwjson.api.updatePage(page).done((page) => {
							console.log("Upload succesful");
							cbs.success('File:' + target);
							mw.hook( 'jsoneditor.file.uploaded' ).fire({exists: false, name: target, label: label});
						}).fail(function (error) {
							console.log("Upload failed:", error);
							cbs.failure('Upload failed:' + error);
						});
					}).fail(function (error) {
						//console.log("File does not exists");
						mwjson.api.getPage("File:" + target).done((page) => {
							page.file = file;
							page.file.contentBlob = file;
							page.file.changed = true;
							mwjson.api.updatePage(page).done((page) => {
								cbs.success('File:' + target);
								mw.hook( 'jsoneditor.file.uploaded' ).fire({exists: false, name: target, label: file.name});
							}).fail(function (error) {
								cbs.failure('Upload failed:' + error);
							});
						});
					});
					
				}
			}
			
		};

		// register compare operator 
		// e.g. {{#when <operand1> 'eq' <operand2>}} {{/when}}
		// {{#when var1 'eq' var2}}equal{{else when var1 'gt' var2}}gt{{else}}lt{{/when}}
		Handlebars.registerHelper("when", (operand_1, operator, operand_2, options) => {
			let operators = {
				'eq': (l, r) => l == r,
				'==': (l, r) => l == r,
				'===': (l, r) => l === r,
				'noteq': (l, r) => l != r,
				'!=': (l, r) => l != r,
				'!==': (l, r) => l !== r,
				'gt': (l, r) => (+l) > (+r),
				'>': (l, r) => (+l) > (+r),
				'gteq': (l, r) => ((+l) > (+r)) || (l == r),
				'>=': (l, r) => ((+l) > (+r)) || (l == r),
				'lt': (l, r) => (+l) < (+r),
				'<': (l, r) => (+l) < (+r),
				'lteq': (l, r) => ((+l) < (+r)) || (l == r),
				'<=': (l, r) => ((+l) < (+r)) || (l == r),
				'or': (l, r) => l || r,
				'||': (l, r) => l || r,
				'and': (l, r) => l && r,
				'&&': (l, r) => l && r,
				'mod': (l, r) => (l % r) === 0,
				'%': (l, r) => (l % r) === 0
			};
			let result = operators[operator](operand_1, operand_2);
			if (result) return options.fn(this);
			return options.inverse(this);
		});

		// register replace operator 
		// e. g. {{#replace <find> <replace>}}{{string}}{{/replace}}
		Handlebars.registerHelper('replace', function( find, replace, options) {
			let string = options.fn(this);
			return string.replaceAll( find, replace );
		});

		// register split operator 	
		// {{#split <find> <index>}}<string>{{/split}}
		// e. g. {{#split "/" -1}}https://test.com/target{{/split}} => target
		Handlebars.registerHelper('split', function( find, index, options) {
			let string = options.fn(this);
			let result = string.split( find );
          	if (index < 0) return result[result.length + index];
            else return result[index];
		});

		// register split interator
		// {{#each_split <string> <find>}}...{{/each_split}}
		// e. g. {{#each_split "https://test.com/target" "/"}}{{.}},{{/each_split}} => https:,,test.com,target, 
		Handlebars.registerHelper('each_split', function( string, find, options) {
          	let data = string.split(find);
          	let result = '';
          data.forEach((item) => {
              result += options.fn(item);
          });
          return result;
		});

		// register substring operator
		// {{#substring start end}}<string>{{/substring}}
		// e. g. {{#substring 0 4}}My-test-string{{/substring}} => My-t
		// e. g. {{#substring -2 ""}}My-test-string{{/substring}} => ng
		// e. g. {{#substring 0 -2}}My-test-string{{/substring}} => My-test-stri
		Handlebars.registerHelper('substring', function( start, end, options) {
			let string = options.fn(this);
			let result = "";
          	if (end === "") result = string.slice( start);
          	else result = string.slice( start, end );
			return result;
		});

		// register pattern formator
		// {{#patternformat pattern}}<string>{{/substring}}
		// e. g. {{#patternformat '00.00'}}{{test}}{{/patternformat}}
		// e. g. {{#patternformat '00'}}2{{/patternformat}} => 02
		// or {{patternformat pattern value}}
		// e. g. {{patternformat '0.0' test}}
		// e. g. {{patternformat '0.0000' 1.129141 }} => 1.1291
		// e. g. {{patternformat '00.0000' '1.1' }} => 01.1000
		// e. g. {{patternformat '_____' 'abc' }} => __abc
		Handlebars.registerHelper('patternformat', function (pattern, value_or_options, options) {
			let value = "";
			if (!options && !value_or_options) return value; // no pattern given
			if (!options) { // helper used as block
				options = value_or_options
				value = options.fn(this);
			}
			else value = value_or_options; // helper used as function
			if (typeof (value) == 'number') value = value.toString();

			let pre_pattern = pattern.split('.')[0] //format for int
			let post_pattern = ""
			if (pattern.includes('.')) post_pattern = pattern.split('.')[1]
			if (post_pattern !== "") {
				//format floats with rounding
				value = "" + parseFloat(value).toFixed(post_pattern.length);
				if (pre_pattern !== "") value = (pre_pattern + value.split('.')[0]).substr(-pre_pattern.length) + '.' + value.split('.')[1];
			}
			else {
				//format integers or strings with leading chars
				value = (pre_pattern + value).substr(-pre_pattern.length);
			}
			return value
		})

		// register current datetime
		// {{now}}
		// e. g. {{now}} => 2024-02-04T04:31:08.050Z 
		// consider: https://github.com/userfrosting/UserFrosting/issues/756
		Handlebars.registerHelper('_now_', function (options) {
			return new Date(Date.now()).toISOString();
		})
		// register alias
		//Handlebars.registerHelper('now', function (options) {
		//	return Handlebars.helpers.__now__.apply(options);
		//})


		// register current datetime
		// {{__uuid__}}
		// e. g. {{__uuid__}} => ad56b31f-9fe5-466a-8be7-89bce58045f1
		Handlebars.registerHelper('_uuid_', function (options) {
			//return mwjson.util.uuidv4();
			return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
				(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
			);
			//return crypto.randomUUID().toString(); //only works in safe env: localhost or https
		})

		// register date formater
		// {{__format_datetime__ <format> <date>}}
		// e. g. {{__format_datetime__ 'Y' (__now__)}} => 2024
		// consider: https://support.helpdocs.io/article/kvaf7f4kf9-handlebars-helpers-for-custom-templates
		Handlebars.registerHelper('dateformat', function (format, date, options) {
			if (!options) {
				options = format;
				format = "YYYY-MM-DD HH:MM"
			}
			//return new Date(Date.parse(date)).toISOString()
			date = new Date(Date.parse(date));
			let result = flatpickr.formatDate(date, format);
			return result;
		})

		// register math callback
		// {{calc (calc 1 '+' 1) '*' 10}} => 20
		// {{#calc 3 '*'}}2{{/calc}} => 6
		Handlebars.registerHelper("calc", function (lvalue, operator, rvalue, options) {
			if (!options) {
				options = rvalue;
				//rvalue = operator;
				//operator = lvalue;
				//lvalue = options.fn(this);
				rvalue = options.fn(this);
			}
			lvalue = parseFloat(lvalue);
			rvalue = parseFloat(rvalue);

			return {
				"+": lvalue + rvalue,
				"-": lvalue - rvalue,
				"*": lvalue * rvalue,
				"/": lvalue / rvalue,
				"%": lvalue % rvalue
			}[operator];
		});
	};
}
