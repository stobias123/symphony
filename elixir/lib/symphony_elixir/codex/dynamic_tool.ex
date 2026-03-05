defmodule SymphonyElixir.Codex.DynamicTool do
  @moduledoc """
  Executes client-side tool calls requested by Codex app-server turns.
  """

  alias SymphonyElixir.{Config, Linear.Client}

  @linear_graphql_tool "linear_graphql"
  @linear_graphql_description """
  Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.
  """
  @linear_graphql_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => ["query"],
    "properties" => %{
      "query" => %{
        "type" => "string",
        "description" => "GraphQL query or mutation document to execute against Linear."
      },
      "variables" => %{
        "type" => ["object", "null"],
        "description" => "Optional GraphQL variables object.",
        "additionalProperties" => true
      }
    }
  }

  @jira_rest_tool "jira_rest"
  @jira_rest_description """
  Execute a REST API call against Jira using Symphony's configured auth.
  """
  @jira_rest_input_schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => ["method", "path"],
    "properties" => %{
      "method" => %{
        "type" => "string",
        "enum" => ["GET", "POST", "PUT", "DELETE"],
        "description" => "HTTP method."
      },
      "path" => %{
        "type" => "string",
        "description" => "REST API path (e.g. /rest/api/3/issue/PROJ-123). Appended to the configured Jira endpoint."
      },
      "body" => %{
        "type" => ["object", "null"],
        "description" => "Optional JSON request body.",
        "additionalProperties" => true
      },
      "query" => %{
        "type" => ["object", "null"],
        "description" => "Optional query parameters as key-value pairs.",
        "additionalProperties" => true
      }
    }
  }

  @spec execute(String.t() | nil, term(), keyword()) :: map()
  def execute(tool, arguments, opts \\ []) do
    case tool do
      @linear_graphql_tool ->
        execute_linear_graphql(arguments, opts)

      @jira_rest_tool ->
        execute_jira_rest(arguments, opts)

      other ->
        failure_response(%{
          "error" => %{
            "message" => "Unsupported dynamic tool: #{inspect(other)}.",
            "supportedTools" => supported_tool_names()
          }
        })
    end
  end

  @spec tool_specs() :: [map()]
  def tool_specs do
    case Config.tracker_kind() do
      "jira" -> [jira_rest_spec()]
      _ -> [linear_graphql_spec()]
    end
  end

  defp linear_graphql_spec do
    %{
      "name" => @linear_graphql_tool,
      "description" => @linear_graphql_description,
      "inputSchema" => @linear_graphql_input_schema
    }
  end

  defp jira_rest_spec do
    %{
      "name" => @jira_rest_tool,
      "description" => @jira_rest_description,
      "inputSchema" => @jira_rest_input_schema
    }
  end

  # Linear GraphQL execution

  defp execute_linear_graphql(arguments, opts) do
    linear_client = Keyword.get(opts, :linear_client, &Client.graphql/3)

    with {:ok, query, variables} <- normalize_linear_graphql_arguments(arguments),
         {:ok, response} <- linear_client.(query, variables, []) do
      graphql_response(response)
    else
      {:error, reason} ->
        failure_response(tool_error_payload(reason))
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_binary(arguments) do
    case String.trim(arguments) do
      "" -> {:error, :missing_query}
      query -> {:ok, query, %{}}
    end
  end

  defp normalize_linear_graphql_arguments(arguments) when is_map(arguments) do
    with {:ok, query} <- normalize_query(arguments),
         {:ok, variables} <- normalize_variables(arguments) do
      {:ok, query, variables}
    end
  end

  defp normalize_linear_graphql_arguments(_arguments), do: {:error, :invalid_arguments}

  defp normalize_query(arguments) do
    case Map.get(arguments, "query") || Map.get(arguments, :query) do
      query when is_binary(query) ->
        case String.trim(query) do
          "" -> {:error, :missing_query}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, :missing_query}
    end
  end

  defp normalize_variables(arguments) do
    case Map.get(arguments, "variables") || Map.get(arguments, :variables) || %{} do
      variables when is_map(variables) -> {:ok, variables}
      _ -> {:error, :invalid_variables}
    end
  end

  defp graphql_response(response) do
    success =
      case response do
        %{"errors" => errors} when is_list(errors) and errors != [] -> false
        %{errors: errors} when is_list(errors) and errors != [] -> false
        _ -> true
      end

    %{
      "success" => success,
      "contentItems" => [
        %{
          "type" => "inputText",
          "text" => encode_payload(response)
        }
      ]
    }
  end

  # Jira REST execution

  defp execute_jira_rest(arguments, opts) when is_map(arguments) do
    request_fun = Keyword.get(opts, :jira_request_fun, &jira_http_request/4)

    with {:ok, method} <- normalize_jira_method(arguments),
         {:ok, path} <- normalize_jira_path(arguments) do
      body = Map.get(arguments, "body") || Map.get(arguments, :body)
      query = Map.get(arguments, "query") || Map.get(arguments, :query) || %{}
      do_jira_request(request_fun, method, path, body, query)
    else
      {:error, reason} ->
        failure_response(tool_error_payload(reason))
    end
  end

  defp execute_jira_rest(_arguments, _opts), do: failure_response(tool_error_payload(:jira_invalid_arguments))

  defp normalize_jira_method(arguments) do
    case Map.get(arguments, "method") || Map.get(arguments, :method) do
      method when method in ["GET", "POST", "PUT", "DELETE"] -> {:ok, method}
      nil -> {:error, :jira_missing_method}
      _ -> {:error, :jira_invalid_method}
    end
  end

  defp normalize_jira_path(arguments) do
    case Map.get(arguments, "path") || Map.get(arguments, :path) do
      path when is_binary(path) ->
        case String.trim(path) do
          "" -> {:error, :jira_missing_path}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, :jira_missing_path}
    end
  end

  defp do_jira_request(request_fun, method, path, body, query) do
    endpoint = Config.jira_endpoint()

    if is_nil(endpoint) do
      failure_response(tool_error_payload(:missing_jira_endpoint))
    else
      url = endpoint <> path

      case request_fun.(method, url, body, query) do
        {:ok, %{status: status, body: resp_body}} when status in 200..299 ->
          success_response(resp_body)

        {:ok, %{status: status, body: resp_body}} ->
          failure_response(%{
            "error" => %{
              "message" => "Jira REST request failed with HTTP #{status}.",
              "status" => status,
              "body" => resp_body
            }
          })

        {:error, reason} ->
          failure_response(tool_error_payload({:jira_api_request, reason}))
      end
    end
  end

  defp jira_http_request(method, url, body, query) do
    headers = jira_auth_headers()
    opts = [headers: headers, params: query, connect_options: [timeout: 30_000]]

    opts = if body, do: Keyword.put(opts, :json, body), else: opts

    case String.upcase(method) do
      "GET" -> Req.get(url, opts)
      "POST" -> Req.post(url, opts)
      "PUT" -> Req.put(url, opts)
      "DELETE" -> Req.delete(url, opts)
    end
  end

  defp jira_auth_headers do
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

  # Shared response helpers

  defp success_response(body) do
    %{
      "success" => true,
      "contentItems" => [
        %{
          "type" => "inputText",
          "text" => encode_payload(body)
        }
      ]
    }
  end

  defp failure_response(payload) do
    %{
      "success" => false,
      "contentItems" => [
        %{
          "type" => "inputText",
          "text" => encode_payload(payload)
        }
      ]
    }
  end

  defp encode_payload(payload) when is_map(payload) or is_list(payload) do
    Jason.encode!(payload, pretty: true)
  end

  defp encode_payload(payload), do: inspect(payload)

  # Error payloads — Linear

  defp tool_error_payload(:missing_query) do
    %{
      "error" => %{
        "message" => "`linear_graphql` requires a non-empty `query` string."
      }
    }
  end

  defp tool_error_payload(:invalid_arguments) do
    %{
      "error" => %{
        "message" => "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`."
      }
    }
  end

  defp tool_error_payload(:invalid_variables) do
    %{
      "error" => %{
        "message" => "`linear_graphql.variables` must be a JSON object when provided."
      }
    }
  end

  defp tool_error_payload(:missing_linear_api_token) do
    %{
      "error" => %{
        "message" => "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`."
      }
    }
  end

  defp tool_error_payload({:linear_api_status, status}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed with HTTP #{status}.",
        "status" => status
      }
    }
  end

  defp tool_error_payload({:linear_api_request, reason}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed before receiving a successful response.",
        "reason" => inspect(reason)
      }
    }
  end

  # Error payloads — Jira

  defp tool_error_payload(:jira_invalid_arguments) do
    %{
      "error" => %{
        "message" => "`jira_rest` expects an object with `method`, `path`, and optional `body`/`query`."
      }
    }
  end

  defp tool_error_payload(:jira_missing_method) do
    %{
      "error" => %{
        "message" => "`jira_rest` requires a `method` (GET, POST, PUT, or DELETE)."
      }
    }
  end

  defp tool_error_payload(:jira_invalid_method) do
    %{
      "error" => %{
        "message" => "`jira_rest.method` must be one of GET, POST, PUT, or DELETE."
      }
    }
  end

  defp tool_error_payload(:jira_missing_path) do
    %{
      "error" => %{
        "message" => "`jira_rest` requires a non-empty `path` string."
      }
    }
  end

  defp tool_error_payload(:missing_jira_endpoint) do
    %{
      "error" => %{
        "message" => "Symphony is missing Jira endpoint. Set `tracker.endpoint` in `WORKFLOW.md`."
      }
    }
  end

  defp tool_error_payload(:missing_jira_api_token) do
    %{
      "error" => %{
        "message" => "Symphony is missing Jira auth. Set `tracker.api_key` in `WORKFLOW.md` or export `JIRA_API_KEY`."
      }
    }
  end

  defp tool_error_payload({:jira_api_request, reason}) do
    %{
      "error" => %{
        "message" => "Jira REST request failed before receiving a successful response.",
        "reason" => inspect(reason)
      }
    }
  end

  # Fallback

  defp tool_error_payload(reason) do
    %{
      "error" => %{
        "message" => "Tool execution failed.",
        "reason" => inspect(reason)
      }
    }
  end

  defp supported_tool_names do
    Enum.map(tool_specs(), & &1["name"])
  end
end
