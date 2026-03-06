defmodule SymphonyElixir.Jira.Client do
  @moduledoc """
  Thin Jira REST API client for polling candidate issues.
  """

  require Logger
  alias SymphonyElixir.{Config, Linear.Issue}

  @max_results 50
  @max_error_body_log_bytes 1_000

  @spec fetch_candidate_issues() :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_candidate_issues do
    project_key = Config.jira_project_key()

    cond do
      is_nil(Config.jira_api_token()) ->
        {:error, :missing_jira_api_token}

      is_nil(Config.jira_endpoint()) ->
        {:error, :missing_jira_endpoint}

      is_nil(project_key) ->
        {:error, :missing_jira_project_key}

      true ->
        active_states = Config.tracker_active_states()
        jql = build_jql(project_key, active_states, Config.jira_assignee())
        do_search(jql)
    end
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_states(state_names) when is_list(state_names) do
    normalized = Enum.map(state_names, &to_string/1) |> Enum.uniq()

    if normalized == [] do
      {:ok, []}
    else
      project_key = Config.jira_project_key()

      cond do
        is_nil(Config.jira_api_token()) -> {:error, :missing_jira_api_token}
        is_nil(Config.jira_endpoint()) -> {:error, :missing_jira_endpoint}
        is_nil(project_key) -> {:error, :missing_jira_project_key}
        true ->
          jql = build_jql(project_key, normalized, nil)
          do_search(jql)
      end
    end
  end

  @spec fetch_issue_states_by_ids([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issue_states_by_ids(issue_ids) when is_list(issue_ids) do
    ids = Enum.uniq(issue_ids)

    if ids == [] do
      {:ok, []}
    else
      jql = "id in (#{Enum.map_join(ids, ",", &quote_jql_value/1)})"
      do_search(jql)
    end
  end

  @spec add_comment(String.t(), String.t()) :: :ok | {:error, term()}
  def add_comment(issue_id_or_key, body) when is_binary(issue_id_or_key) and is_binary(body) do
    path = "/rest/api/3/issue/#{URI.encode(issue_id_or_key)}/comment"
    payload = %{"body" => adf_paragraph(body)}

    case post_json(path, payload) do
      {:ok, %{status: status}} when status in [200, 201] -> :ok
      {:ok, response} -> {:error, {:jira_api_status, response.status}}
      {:error, reason} -> {:error, {:jira_api_request, reason}}
    end
  end

  @spec transition_issue(String.t(), String.t()) :: :ok | {:error, term()}
  def transition_issue(issue_id_or_key, target_state_name)
      when is_binary(issue_id_or_key) and is_binary(target_state_name) do
    with {:ok, transition_id} <- resolve_transition_id(issue_id_or_key, target_state_name) do
      path = "/rest/api/3/issue/#{URI.encode(issue_id_or_key)}/transitions"
      payload = %{"transition" => %{"id" => transition_id}}

      case post_json(path, payload) do
        {:ok, %{status: status}} when status in [200, 204] -> :ok
        {:ok, response} -> {:error, {:jira_api_status, response.status}}
        {:error, reason} -> {:error, {:jira_api_request, reason}}
      end
    end
  end

  defp do_search(jql, start_at \\ 0, acc \\ []) do
    path = "/rest/api/3/search/jql"

    params = %{
      "jql" => jql,
      "startAt" => start_at,
      "maxResults" => @max_results,
      "fields" => "summary,description,priority,status,labels,issuelinks,assignee,created,updated"
    }

    case get_json(path, params) do
      {:ok, %{status: 200, body: body}} ->
        issues = body |> Map.get("issues", []) |> Enum.map(&normalize_issue/1)
        all_issues = acc ++ issues
        total = Map.get(body, "total", 0)

        if start_at + length(issues) < total do
          do_search(jql, start_at + length(issues), all_issues)
        else
          {:ok, all_issues}
        end

      {:ok, response} ->
        Logger.error(
          "Jira search request failed status=#{response.status}" <>
            jira_error_context(jql, response)
        )

        {:error, {:jira_api_status, response.status}}

      {:error, reason} ->
        Logger.error("Jira search request failed: #{inspect(reason)}")
        {:error, {:jira_api_request, reason}}
    end
  end

  defp normalize_issue(%{"id" => id, "key" => key, "fields" => fields}) do
    %Issue{
      id: id,
      identifier: key,
      title: Map.get(fields, "summary"),
      description: extract_description(Map.get(fields, "description")),
      priority: extract_priority(Map.get(fields, "priority")),
      state: get_in(fields, ["status", "name"]),
      branch_name: nil,
      url: "#{Config.jira_endpoint()}/browse/#{key}",
      assignee_id: get_in(fields, ["assignee", "accountId"]),
      blocked_by: extract_blockers(Map.get(fields, "issuelinks", [])),
      labels: fields |> Map.get("labels", []) |> Enum.map(&String.downcase/1),
      assigned_to_worker: true,
      created_at: parse_datetime(Map.get(fields, "created")),
      updated_at: parse_datetime(Map.get(fields, "updated"))
    }
  end

  defp normalize_issue(_), do: nil

  defp extract_description(nil), do: nil

  defp extract_description(%{"content" => content}) when is_list(content) do
    content
    |> Enum.flat_map(&extract_adf_text/1)
    |> Enum.join("\n")
  end

  defp extract_description(desc) when is_binary(desc), do: desc
  defp extract_description(_), do: nil

  defp extract_adf_text(%{"type" => "paragraph", "content" => children}) when is_list(children) do
    text = children |> Enum.map_join("", &extract_adf_text_node/1)
    [text]
  end

  defp extract_adf_text(%{"content" => children}) when is_list(children) do
    Enum.flat_map(children, &extract_adf_text/1)
  end

  defp extract_adf_text(_), do: []

  defp extract_adf_text_node(%{"type" => "text", "text" => text}), do: text
  defp extract_adf_text_node(_), do: ""

  defp extract_priority(%{"id" => id}) when is_binary(id) do
    case Integer.parse(id) do
      {parsed, _} -> parsed
      :error -> nil
    end
  end

  defp extract_priority(_), do: nil

  defp extract_blockers(links) when is_list(links) do
    Enum.flat_map(links, fn
      %{"type" => %{"inward" => inward}, "inwardIssue" => blocker} when is_map(blocker) ->
        if String.downcase(inward) =~ "blocked by" do
          [
            %{
              id: blocker["id"],
              identifier: blocker["key"],
              state: get_in(blocker, ["fields", "status", "name"])
            }
          ]
        else
          []
        end

      _ ->
        []
    end)
  end

  defp extract_blockers(_), do: []

  defp parse_datetime(nil), do: nil

  defp parse_datetime(raw) when is_binary(raw) do
    case DateTime.from_iso8601(raw) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp parse_datetime(_), do: nil

  defp resolve_transition_id(issue_id_or_key, target_state_name) do
    path = "/rest/api/3/issue/#{URI.encode(issue_id_or_key)}/transitions"

    case get_json(path, %{}) do
      {:ok, %{status: 200, body: %{"transitions" => transitions}}} ->
        target = String.downcase(String.trim(target_state_name))

        case Enum.find(transitions, fn t ->
               String.downcase(get_in(t, ["to", "name"]) || "") == target
             end) do
          %{"id" => id} -> {:ok, id}
          nil -> {:error, {:jira_transition_not_found, target_state_name}}
        end

      {:ok, response} ->
        {:error, {:jira_api_status, response.status}}

      {:error, reason} ->
        {:error, {:jira_api_request, reason}}
    end
  end

  defp build_jql(project_key, state_names, assignee) do
    states_clause =
      state_names
      |> Enum.map_join(",", &quote_jql_value/1)
      |> then(&"status in (#{&1})")

    clauses = ["project = #{quote_jql_value(project_key)}", states_clause]

    clauses =
      case assignee do
        "me" -> clauses ++ ["assignee = currentUser()"]
        val when is_binary(val) and val != "" -> clauses ++ ["assignee = #{quote_jql_value(val)}"]
        _ -> clauses
      end

    Enum.join(clauses, " AND ") <> " ORDER BY priority ASC, updated DESC"
  end

  defp quote_jql_value(value) do
    escaped = String.replace(value, "\"", "\\\"")
    "\"#{escaped}\""
  end

  defp adf_paragraph(text) do
    %{
      "type" => "doc",
      "version" => 1,
      "content" => [
        %{
          "type" => "paragraph",
          "content" => [
            %{"type" => "text", "text" => text}
          ]
        }
      ]
    }
  end

  defp get_json(path, params) do
    url = Config.jira_endpoint() <> path

    request_fun().get(url,
      headers: auth_headers(),
      params: params,
      connect_options: [timeout: 30_000]
    )
  end

  defp post_json(path, payload) do
    url = Config.jira_endpoint() <> path

    request_fun().post(url,
      headers: auth_headers(),
      json: payload,
      connect_options: [timeout: 30_000]
    )
  end

  defp auth_headers do
    token = Config.jira_api_token()
    email = Config.jira_email()

    if is_binary(email) and email != "" do
      encoded = Base.encode64("#{email}:#{token}")

      [
        {"Authorization", "Basic #{encoded}"},
        {"Content-Type", "application/json"},
        {"Accept", "application/json"}
      ]
    else
      [
        {"Authorization", "Bearer #{token}"},
        {"Content-Type", "application/json"},
        {"Accept", "application/json"}
      ]
    end
  end

  defp request_fun do
    Application.get_env(:symphony_elixir, :jira_request_module, Req)
  end

  defp jira_error_context(jql, response) do
    body =
      response
      |> Map.get(:body)
      |> summarize_error_body()

    " jql=#{inspect(jql)} body=#{body}"
  end

  defp summarize_error_body(body) when is_binary(body) do
    body
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
    |> truncate_error_body()
    |> inspect()
  end

  defp summarize_error_body(body) do
    body
    |> inspect(limit: 20, printable_limit: @max_error_body_log_bytes)
    |> truncate_error_body()
  end

  defp truncate_error_body(body) when is_binary(body) do
    if byte_size(body) > @max_error_body_log_bytes do
      binary_part(body, 0, @max_error_body_log_bytes) <> "...<truncated>"
    else
      body
    end
  end
end
